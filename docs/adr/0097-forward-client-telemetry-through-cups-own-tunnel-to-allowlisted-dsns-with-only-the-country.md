---
status: accepted
---

# Forward client telemetry through Cup's own tunnel to allowlisted DSNs, with only the listener's country

The web app and the shells' JS send their telemetry to Sentry. Sent directly, it would expose the listener's IP address to Sentry and be dropped by ad blockers that block Sentry's hosts. The Worker therefore runs a telemetry tunnel. It was decided with the observability spec [cup-audio/cup#403](https://github.com/cup-audio/cup/issues/403) for Linear CUP-37 and implemented in [cup-audio/cup#422](https://github.com/cup-audio/cup/pull/422). These decisions were recorded from code comments on 2026-11-23.

## Decision

- **The client sends through Cup's own domain**, so ad blockers that block Sentry's hosts don't drop it ([client Sentry options](../../libs/telemetry.browser/src/client-sentry-options.ts)). The tunnel lives at [`/_/e`](../../libs/telemetry.core/src/telemetry-tunnel-path.ts) on the Worker, at the API origin and outside `/api/*`: the client SDKs send their envelopes to it, and the API server routes it to the tunnel.
- **It is no open proxy** ([tunnel](../../libs/telemetry.cloudflare/src/telemetry-tunnel.ts)). It forwards only envelopes for a DSN listed in the Worker var `SENTRY_TUNNEL_DSNS` (comma-separated) and answers any other with a 403. In production the list is exactly the `cup-app` DSN, and `pnpm dev:services` sets it to `""` ([`wrangler.jsonc`](../../apps/cloudflare-worker/wrangler.jsonc)). The allowlist is checked by Cup, because Sentry's `handleTunnelRequest` also allows the DSN of the Worker's own Sentry client.
- **Sentry never sees the listener's IP address.** The IP headers are removed before forwarding, because `handleTunnelRequest` would forward the first IP header it finds to Sentry as `X-Sentry-Forwarded-For`.
- **Only the listener's country reaches Sentry** ([envelope rewrite](../../libs/telemetry.cloudflare/src/tunnel-envelope.ts)). Every `event` and `transaction` item, the item types whose payload is an event with a `user` from which Sentry reads `user.geo`, gets `user.geo` set to the listener's country, `request.cf.country` as Cloudflare reports it (`XX` and `T1` included), replacing whatever geo the client sent; without a country, those items lose `user.geo`. Each rewritten item gets the length header of its new payload; every other item, `span` included, keeps its bytes.
- **The envelope format follows Sentry's developer docs** as read on 2026-11-16 (<https://develop.sentry.dev/sdk/data-model/envelopes/>): a JSON header line, then items, each a JSON item header line followed by a payload that is `length` bytes long when the item header declares a length and runs to the next newline otherwise. A body that is no envelope is answered with a 400.
- **The rewritten request carries a `Content-Length`**, because the tunnel answers a request without a length with a 411.
- **Sentry's rate-limit headers come back.** The tunnel forwards `Content-Type`, `Retry-After` and `X-Sentry-Rate-Limits` from Sentry's answer, the headers the client SDK reads for its rate limits.

## Consequences

- Client telemetry depends on the Worker being up.
- Allowing another project's DSN needs a change to `SENTRY_TUNNEL_DSNS`; the Worker's own DSN stays refused.

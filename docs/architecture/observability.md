# Observability

Cup reports production failures to Sentry through Sentry's own SDKs, and only from production. Cloudflare Workers Observability is off. [ADR 0029](../adr/0029-observe-production-with-sentrys-own-sdks-and-turn-cloudflares-observability-off.md) records why; the [spec](https://github.com/patricktree/cup/issues/403) describes the whole effort, of which this page describes what is built.

## What the Worker sends

Every Worker entry point is wrapped with `@sentry/cloudflare` in the [Worker entry](../../apps/cloudflare-worker/src/index.ts): the `fetch` handler, the account, conversion grant and registry Durable Objects, and the preparation and audio segment synthesis Workflows. Each sends to the `cup-worker` project:

- **Errors**, captured once where Cup turns an error into a 500 response: Hono's `onError`, and each `catch` in the [API server](../../libs/api-server/src/api-server.ts) that answers `operational-error` with status 500. A 4xx response captures nothing. Each event carries the `cup.component` tag, which names the entry point that reported it.
- **Traces**, every request except the health checks ([sampling](#sampling)), streamed span by span. A request's trace includes its Durable Object RPC calls: Sentry appends the trace context to each RPC call on the Worker's own Durable Object bindings, and the wrapped receiver removes it again. Durable Object SQL and storage spans are dropped, because they would outnumber all others.
- **Logs**, only Cup's own [log records](#log-records), at `info` and above.
- **The release**, the deployed Worker version from the `CF_VERSION_METADATA` binding, and the environment `production`.

Sentry's projects, keys and privacy settings are managed in [Terraform](../../terraform/README.md#sentry); the two public DSNs are constants in `@cup/telemetry.core`. The `cup-app` project for the web app and the shells exists, and the [telemetry tunnel](#telemetry-tunnel) forwards to it, but no client sends yet.

Planned by the spec and not built yet: the conversion outcome `info` events, the `cup.conversion.id` join key on every conversion-scoped record, `traceId` in error bodies, captures in the Durable Objects and Workflows, alerts and monitors including the uptime monitor on `/api/health`, client telemetry in the web app and the shells, and source map upload.

## Sampling

The Worker traces every invocation, the web app's polls included, except `GET /api/health`. The `tracesSampler` in [`@cup/telemetry.cloudflare`](../../libs/telemetry.cloudflare/src/worker-sentry-options.ts) returns 0 for the request span whose `url.path` is `/api/health` and 1 for every other one. The health endpoint is a Listener API route that answers 200 while the Worker runs and calls no binding; Sentry's uptime monitor is to check it every minute, and its near-empty traces would take about 43k spans a month of the free plan's quota. If span volume grows, a later change lowers the trace rate where little is lost, starting with the polls.

## Stuck checks

A stuck check reports work that should have finished long ago as one Sentry error event per case, with a fixed fingerprint, so all cases land in one issue. A flag stored with the work keeps later passes from reporting the same case again.

- **Conversion stuck.** The account and conversion grant alarms run the [stuck-conversion check](conversion.md#stuck-conversions) on every pass. A conversion stuck in preparation or in synthesis sends one event per stage, with the fingerprint `["conversion-stuck", "preparation"]` or `["conversion-stuck", "synthesis"]`, so each stage is one issue. The event carries the tags `cup.conversion.id`, `cup.conversion.stage`, `cup.owner.kind`, and the opaque `cup.account.id` or `cup.conversion_grant.id`, plus `cup.conversion.phase`, the conversion phase it last started, for preparation; the `stuck_conversion` context holds the stage's age in minutes. The flag is a column of the conversion row, and starting a stage again clears it, so a retry that hangs again is reported again. A conversion that settles after its report sends nothing, and the operator resolves the issue by hand. The thresholds of 15 and 60 minutes are deliberately generous; tighten them once conversion durations are visible. The message names the conversion ID, so Sentry's Dedupe integration does not drop the next conversion's report as a repeat.
- **Conversion deletion stuck.** The account alarm runs the [stuck-conversion-deletion check](conversion-deletion.md#invariants) on every pass, right after the cleanup of marked conversions. A conversion still marked for deletion more than 1 h after it was marked sends one event with the fingerprint `["conversion-deletion-stuck"]`. It carries the tag `cup.conversion.id`, and `cup.component` from the account object's scope; the `stuck_conversion_deletion` context holds the age in minutes. It names no root cause: the per-pass `conversion-deletion-cleanup-failed` warnings hold that, and a cleanup that waits on an undrained artifact writer fails no pass, which is why the check measures age. The flag is the `deletion_stuck_reported_at_ms` column of the marked account conversion row, which goes with the row once the cleanup finishes. The message names the conversion ID, so Sentry's Dedupe integration does not drop the next conversion's report as a repeat.
- **Account deletion stuck.** The registry's [deletion coordinator](account-deletion.md#fencing-and-cleanup) checks every unfinished deletion attempt on each of its alarm passes. An attempt still neither erased nor restored 1 h after its recovery deadline is overdue, which means the same as stuck. Its event has the fingerprint `["account-deletion-stuck"]` and the tags `cup.account.id`, `cup.account_deletion.attempt_id` and `cup.account_deletion.pending`. The last names what is pending: `identity`, `account` or `both`, where the account fence counts as `account`. The flag is the `stuckReported` field of the attempt's job JSON, so it needs no migration. Retries back off to at most 1 h, so the report arrives at most about 2 h after the deadline. The Operator CLI's `overdue` uses the same threshold. The event's message names the attempt ID, so Sentry's Dedupe integration does not drop the report of a second stuck attempt as a repeat of the first.

## Log records

Every Worker log record goes through `logEvent` in `@cup/telemetry.cloudflare`, which writes it with `Sentry.logger`; no Worker source calls `console.*`, and Sentry's console integrations stay off. A record has:

- a stable, kebab-case event name from the catalogue, as the `event.name` attribute;
- a prose message;
- its details as attributes: `cup.*` keys from `@cup/telemetry.core` or semantic-convention names, opaque IDs only, never an email address;
- for a logged error, the root cause as `exception.type`, `exception.message` and `exception.stacktrace`, plus `cup.exception.chain`, the wrapper types from outermost to innermost. Only Cup's own errors keep their message, by the rule of [`libs/errors`](../../libs/errors/README.md); a foreign root cause's stack keeps its frames without the message line.

Each event has one fixed severity, which the catalogue states:

| Severity | Meaning                       | Events                                                                                                                                                                                                                                                                                                    |
| -------- | ----------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `error`  | the operator must look at it  | `narration-track-segment-mismatch`                                                                                                                                                                                                                                                                        |
| `warn`   | degraded but handled          | `content-limit`, `narration-language-fallback`, `narration-language-unspeakable`, `cover-image-unavailable`, `conversion-workflow-termination-failed`, `conversion-deletion-cleanup-failed`, `account-deletion-identity-failed`, `account-deletion-erasure-failed`, `account-deletion-notice-undelivered` |
| `info`   | lifecycle events and outcomes | `operator-mutation`                                                                                                                                                                                                                                                                                       |
| `debug`  | never sent                    | none                                                                                                                                                                                                                                                                                                      |

The catalogue, [`log-events.ts`](../../libs/telemetry.core/src/log-events.ts), describes when each event is written. An expected outcome is a warning, not an issue. Rename an event only together with the saved queries and alerts that use it. The per-pass warnings of [conversion deletion](conversion-deletion.md) and [account deletion](account-deletion.md#fencing-and-cleanup) carry the root cause, so a stalled deletion can be investigated by conversion or account ID.

Outside production, Sentry is off and `logEvent` writes nothing, also not to the console.

## Telemetry libraries

| Library                                                                  | Runtime     | Holds                                                                                                                                                                                                                       |
| ------------------------------------------------------------------------ | ----------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| [`@cup/telemetry.core`](../../libs/telemetry.core/README.md)             | any, no SDK | The `cup.*` attribute keys, the log event catalogue and the `beforeSendLog` severity filter, URL masking and the masking `beforeSendSpan`, the signed-out user, and both production DSNs                                    |
| [`@cup/telemetry.cloudflare`](../../libs/telemetry.cloudflare/README.md) | Workers     | The Worker's Sentry options with the on/off rule, the server `beforeSend` and `beforeSendSpan`, the typed log-event helper `logEvent`, the stuck-conversion and stuck-conversion-deletion reports, and the telemetry tunnel |

Cup code calls Sentry's API directly, such as `captureException` from `@sentry/core`; the libraries hold keys, options, privacy hooks and the log-event helper, not a wrapper around Sentry. The server and client SDK families move on different majors, so the `sentry-server` catalog in `pnpm-workspace.yaml` pins the server family, and the [workspace check](../../qa/workspace-checks/README.md#sentry-sdk-family-check) keeps the families out of each other's packages.

## Telemetry tunnel

Browser and shell JS telemetry reaches Sentry through Cup's own domain, so ad blockers that block Sentry's hosts don't drop it. The [API server](../../libs/api-server/src/api-server.ts) serves the tunnel at `POST /_/e`, outside `/api/*` and the Listener API contract, without authentication or validation middleware; its path avoids "sentry" so filter lists don't match it. It answers CORS for the shells' origins, `capacitor://localhost` and `https://localhost`, without credentials; the browser posts from the same origin.

The handler in [`@cup/telemetry.cloudflare`](../../libs/telemetry.cloudflare/src/telemetry-tunnel.ts) rewrites each envelope before Sentry's `handleTunnelRequest` forwards it:

- it forwards only envelopes whose DSN is on the Worker var `SENTRY_TUNNEL_DSNS` and answers any other with a 403, the Worker's own `cup-worker` DSN included, so the tunnel is no open proxy. Production's list is exactly the `cup-app` DSN;
- it removes the headers that carry the listener's IP address, so Sentry receives no `X-Sentry-Forwarded-For`;
- it sets `user.geo` to `{ country_code }` from `request.cf.country` on every `event` and `transaction` item, replacing any geo the client sent, with Cloudflare's `XX` (unknown) and `T1` (Tor) as reported, and rewrites those items' length headers. Every other item, `span` included, passes unchanged.

The tunnel has no rate limit of its own: the DSN is public anyway, and Sentry's quota and spike protection cap abuse.

## Privacy

The Worker's options set every key of Sentry's `dataCollection`, so no user info, headers, cookies, bodies, AI prompts or query data are collected; query parameters are collected and then masked. The `beforeSendLog` of `@cup/telemetry.core` drops records below `info` and masks the message and string attributes of the rest. The server `beforeSend` and `beforeSendSpan` in `@cup/telemetry.cloudflare` then:

- set the user's IP address to null and drop the IP headers;
- drop the time zone that the SDK copies from `request.cf`, a location finer than the country;
- mask the values of credential query parameters (`token`, `key`, `sig`, `signature`, `auth`, `code`, `access_token`) in URLs, span names and attributes, breadcrumbs and error messages, with the one masking function of `@cup/telemetry.core`;
- keep the messages only of Cup's own errors. A foreign error anywhere in the captured `cause` chain, such as a Drizzle query error that embeds SQL parameters, keeps its class name as its type and loses its message and the properties `extraErrorDataIntegration` copied from it. Cup's own errors are plain `Error`s and the few subclasses that [`libs/errors`](../../libs/errors/README.md) lists.

Sentry's organisation settings scrub again at ingest; the [Terraform guide](../../terraform/README.md#sentry) describes them.

## Nothing is sent outside production

The Worker's `SENTRY_DSN` is a plain var, public by design. The options factory reads it with `LOCAL_DEVELOPMENT` on every invocation and throws when the two disagree, so a misconfigured environment fails every request instead of sending from development or staying quiet in production:

| `LOCAL_DEVELOPMENT` | `SENTRY_DSN` | Result     |
| ------------------- | ------------ | ---------- |
| `"true"`            | empty        | Sentry off |
| `"true"`            | set          | throws     |
| `"false"`           | set          | Sentry on  |
| `"false"`           | empty        | throws     |

| Configuration                                                                        | `LOCAL_DEVELOPMENT` | `SENTRY_DSN`                                                                                                    |
| ------------------------------------------------------------------------------------ | ------------------- | --------------------------------------------------------------------------------------------------------------- |
| Production ([`wrangler.jsonc`](../../apps/cloudflare-worker/wrangler.jsonc))         | `"false"`           | the `cup-worker` DSN                                                                                            |
| `pnpm dev` after `pnpm dev:services`                                                 | `"true"`            | empty, written by the helper                                                                                    |
| [Test Worker](../../qa/test-worker/README.md)                                        | `"true"`            | empty                                                                                                           |
| [Worker integration tests](../../apps/cloudflare-worker/AGENTS.md#integration-tests) | `"false"`           | `http://test@127.0.0.1:9/1`, a discard port, or the Sentry stub's DSN through `useWorker({ sentryDsn })`        |
| [Registry tests](../../libs/registry/wrangler.test.jsonc)                            | `"false"`           | the same discard port, read only by the Sentry-wrapped deletion coordinator test object, or a Sentry stub's DSN |

`SENTRY_TUNNEL_DSNS` is empty everywhere but production, so the tunnel forwards nothing; a test allowlists a Sentry stub DSN through `useWorker({ vars })`, and a suite running the test Worker through `--var`. The Worker's [config test](../../apps/cloudflare-worker/test/wrangler-config.test.ts) and the test Worker's config test pin these values. Tests that check what reaches Sentry start a [Sentry stub](../../qa/sentry-stub/README.md), which records envelopes and forwards nothing.

## Build

The Worker's [Vite configuration](../../apps/cloudflare-worker/vite.config.ts) adds Sentry's Vite plugin for build-time instrumentation only. The Worker entry wraps the entry points itself instead of leaving that to the plugin's auto-instrumentation, because the Worker integration tests run the entry through Wrangler's test harness, which bundles without Vite, and must run the same wrapping as production. Cloudflare receives no source maps (`upload_source_maps: false`).

---
status: accepted
---

# Run Worker integration tests on the production Worker with a config that reaches no paid or external service

The Worker's integration tests must exercise what production runs, yet never incur cost, reach a provider, or depend on a developer's local configuration. [cup-audio/cup#35](https://github.com/cup-audio/cup/pull/35) made them run the whole Worker and pinned its Wrangler config; [cup-audio/cup#422](https://github.com/cup-audio/cup/pull/422), for the observability spec [cup-audio/cup#403](https://github.com/cup-audio/cup/issues/403), pointed Sentry at the discard port and a Sentry stub. These decisions were recorded from code comments on 2026-11-23.

## Decision

- **The test entry is exactly the production Worker.** [`test/worker.ts`](../../apps/cloudflare-worker/test/worker.ts) re-exports `src/index.ts`. Wrangler fails to start the test Worker when a Durable Object or Workflow class that the test config binds is missing from the production entry's exports.
- **The test config lives in `test/`.** [`wrangler.test.jsonc`](../../apps/cloudflare-worker/test/wrangler.test.jsonc) sits there rather than next to `wrangler.jsonc` because Wrangler loads `.dev.vars` and `.env` files from the config's directory: the package's `.env.local` must never change what the integration tests see.
- **It mirrors production minus paid and external services.** `AI` (Workers AI) and `BROWSER` (Browser Rendering) are left out, so code that would call them fails instead of incurring cost; the local Workflow engines exist, but no test starts a conversion, and one that did would fail on the missing `AI`. The Supabase, Cloudflare Access, Resend and Sentry URLs point at the discard port of `127.0.0.1`, unreachable on purpose. [`wrangler-config.test.ts`](../../apps/cloudflare-worker/test/wrangler-config.test.ts) checks that the remaining bindings match production.
- **Sentry runs as in production but sends to the discard port**, unless `useWorker({ sentryDsn })` points it at a Sentry stub. The telemetry tunnel forwards nothing (`SENTRY_TUNNEL_DSNS` is empty) unless `useWorker({ vars })` allowlists a Sentry stub DSN. A test that checks the missing Sentry CLI token runs in an empty home directory and with a discard-port URL, so even a misconfigured run cannot reach Sentry.
- **Secrets are dummies.** [`useWorker`](../../apps/cloudflare-worker/test/use-worker.ts) supplies a dummy value for every secret of `secrets.required` in `wrangler.jsonc`; none is valid for a real provider. An empty `MEDIA_URL_SIGNING_KEY` makes checking a well-formed media URL token's signature throw, which the Listener API answers with a 500: a misconfiguration every test can provoke.
- **The test config's migrations are the result, not the history.** Production reached its set of SQLite classes through several migrations, including a rename; a fresh test runtime needs only the result. Deployed production migrations are history: Cloudflare rejects a deploy whose earlier migrations changed, so a test pins them.
- **Every test starts its own Worker**, a fresh instance of the whole production Worker with empty Durable Object, R2 and Workflow storage, so the tests of a file run concurrently. Pass `onTestFinished` from the test's own context: Vitest tracks hooks per test only through the context, which keeps concurrent tests in one file apart. A test pair that reuses one request ID proves the isolation: with shared storage, one would get `already-issued`.
- **Tests time out after 30 seconds**, because starting a Worker in the local test runtime takes a few hundred milliseconds, more under load.
- **Wrangler config reads are typed by a schema.** Wrangler's declarations import the config types from a package it bundles, so `experimental_readRawConfig()` returns `any`; a loose zod schema of the parts the tests read gives them checked types and passes unlisted keys through ([Wrangler configs](../../apps/cloudflare-worker/test/wrangler-configs.ts)).
- **Waiting for nothing uses a later span as a marker.** An unsampled request, such as the health check, sends nothing to wait for; a traced request made afterwards flushes after the health check's own flush would have, so its span marks the point to assert at ([Sentry test](../../apps/cloudflare-worker/test/sentry.test.ts)).
- **Tests wait on spans because of when Sentry flushes.** Sentry flushes through `waitUntil`, after the handler returned: a request's `http.server` span goes in the flush at the end of the invocation, together with any error event the request captured, and a Workflow run's final flush sends a step's span after the run's events ([conversion failures test](../../apps/cloudflare-worker/test/conversion-failures.test.ts)).

## Consequences

- A binding added to production must be added to the test config, or `wrangler-config.test.ts` fails; a paid or external one is left out and its URL pointed at the discard port.

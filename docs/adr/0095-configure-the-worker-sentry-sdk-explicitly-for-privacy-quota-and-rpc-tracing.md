---
status: accepted
---

# Configure the Worker's Sentry SDK explicitly for privacy, quota and RPC tracing

[ADR 0030](0030-observe-production-with-sentrys-own-sdks-and-turn-cloudflares-observability-off.md) chose `@sentry/cloudflare` for the Worker, its Durable Objects and its Workflows, and the rule that nothing is sent outside production. The SDK's defaults are permissive and some of its behaviours are Cloudflare-specific, so the [Worker Sentry options](../../libs/telemetry.cloudflare/src/worker-sentry-options.ts) set every option that matters explicitly. They were decided with the observability spec [cup-audio/cup#403](https://github.com/cup-audio/cup/issues/403) for Linear CUP-37 and implemented in [cup-audio/cup#422](https://github.com/cup-audio/cup/pull/422). These decisions were recorded from code comments on 2026-11-23.

## Decision

- **Two Sentry projects with public DSNs.** [`sentry-dsns.ts`](../../libs/telemetry.core/src/sentry-dsns.ts) holds the DSNs of `cup-worker` (the Worker's fetch handler, Durable Objects and Workflows) and `cup-app` (the web app and both Capacitor shells), copied once from the Terraform outputs `cup_worker_dsn` and `cup_app_dsn` of `terraform/sentry`. A DSN is public by design: it only lets a client send events to its project. Only production configuration uses them; local development and tests run with an empty DSN or one that points at the Sentry stub. The Worker var `SENTRY_DSN` in [`wrangler.jsonc`](../../apps/cloudflare-worker/wrangler.jsonc) is the `cup-worker` DSN and must agree with `LOCAL_DEVELOPMENT`: `pnpm dev:services` sets it to `""` next to `LOCAL_DEVELOPMENT=true`.
- **Local development leaves `dsn` unset** when it disables Sentry, because the SDK would otherwise fall back to `env.SENTRY_DSN` on its own.
- **The release is `CF_VERSION_METADATA.id`, set explicitly.** `wrangler.jsonc` binds the version metadata so that its ID is the release of every Sentry event; the SDK derives the release from `CF_VERSION_METADATA` too, but not for Workflow events.
- **The component is both a tag and an attribute.** Each entry point names itself as `cup.component`, a tag on errors and an attribute on logs and streamed spans, which take no tags. Likewise [`setConversionScope`](../../libs/telemetry.cloudflare/src/conversion-scope.ts) puts a conversion's keys on Sentry's isolation scope of the current invocation (a Listener API request, a Durable Object RPC call or a Workflow run), as tags on errors and attributes on spans and logs; tags are strings, while attributes keep a number's type. Without an active Sentry client it changes nothing that is sent.
- **Every `dataCollection` key is set**, because an omitted key falls back to the SDK's permissive default. URL query parameters are collected and then masked by Cup's hooks, so non-credential parameters stay readable.
- **The uptime monitor's health checks are not traced.** Sentry's uptime monitor checks the Listener API's health route every minute; the route answers while the Worker runs and calls no binding, so its checks cost nothing beyond the Worker itself ([listener routes](../../libs/listener-api.routes/src/hono-app.ts)). Its traces would be near-empty and use up about 43k spans of the monthly quota, so the trace sampler traces every invocation except `/api/health`.
- **Durable Object SQL and storage spans are ignored** (`db.query` and `durable_object_storage_*`), because they would outnumber every other span.
- **No trace headers to third parties**, and incoming traces continue only from Cup's own organisation (`tracePropagationTargets: []`, `strictTraceContinuation: true`).
- **Trace context propagates over RPC to Cup's own Durable Objects only** (`ACCOUNTS`, `CONVERSION_GRANTS`, `REGISTRY`). Sentry appends the trace context to every RPC call on them as a trailing argument, which only a Sentry-wrapped receiver strips again; the [Worker entry](../../apps/cloudflare-worker/src/index.ts) wraps all three classes.
- **No metrics.** `beforeSendMetric` drops every metric; Cup sends none.

## Consequences

- A new Durable Object binding that receives RPC calls must be wrapped by Sentry before it joins `rpcTracePropagationBindings`, or its methods receive an extra argument.
- An SDK upgrade that adds a `dataCollection` key needs a deliberate value here.
- Health checks show in the uptime monitor, not in traces.

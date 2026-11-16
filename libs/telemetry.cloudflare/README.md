# Telemetry for Cloudflare Workers

Sentry's options and privacy hooks for the Worker, its Durable Objects and its Workflows, on `@sentry/cloudflare`. The [observability page](../../docs/architecture/observability.md) describes what the Worker sends and why.

## Use

[`createWorkerSentryOptions(env, component)`](src/worker-sentry-options.ts) returns the options for one entry point; pass it as the options callback of Sentry's wrapper, as the [Worker entry](../../apps/cloudflare-worker/src/index.ts) does. `component` is a `WorkerComponent`, which becomes the event's `cup.component` tag. Sentry calls the callback on every invocation with the entry point's environment, which needs `LOCAL_DEVELOPMENT`, `SENTRY_DSN` and the `CF_VERSION_METADATA` binding.

The on/off rule: Sentry is off when `LOCAL_DEVELOPMENT` is `"true"` and `SENTRY_DSN` is empty, on when `LOCAL_DEVELOPMENT` is anything else and `SENTRY_DSN` is set, and the callback throws on the two contradictions. Cup code captures with `captureException` from `@sentry/core` directly; this library wraps no Sentry API.

The options include the server `beforeSend` and `beforeSendSpan` from [`server-before-send.ts`](src/server-before-send.ts). They null the IP address, drop IP headers and the time zone, mask URLs with `@cup/telemetry.core`, and keep error messages only for Cup's own errors: plain `Error`s and the subclasses listed in `CUP_ERROR_CLASS_NAMES`. Add a new Cup error subclass to that list, or its message is dropped.

## Tests

The unit tests cover the on/off table and the hooks. [`worker-sentry-pipeline.test.ts`](test/worker-sentry-pipeline.test.ts) runs the options through the real SDK against the [Sentry stub](../../qa/sentry-stub/README.md), for the wrapped foreign error that no Worker request path produces today.

Only this library and packages that depend on it may depend on `@sentry/cloudflare` ([SDK family check](../../qa/workspace-checks/README.md#sentry-sdk-family-check)); take `@sentry/cloudflare` and `@sentry/core` from the `sentry-server` catalog.

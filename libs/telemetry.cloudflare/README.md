# Telemetry for Cloudflare Workers

Sentry's options and privacy hooks for the Worker, its Durable Objects and its Workflows, and the telemetry tunnel's handler, on `@sentry/cloudflare`. The [observability page](../../docs/architecture/observability.md) describes what the Worker sends and why.

## Use

[`createWorkerSentryOptions(env, component)`](src/worker-sentry-options.ts) returns the options for one entry point; pass it as the options callback of Sentry's wrapper, as the [Worker entry](../../apps/cloudflare-worker/src/index.ts) does. `component` is a `WorkerComponent`, which becomes the event's `cup.component` tag. Sentry calls the callback on every invocation with the entry point's environment, which needs `LOCAL_DEVELOPMENT`, `SENTRY_DSN` and the `CF_VERSION_METADATA` binding.

The on/off rule: Sentry is off when `LOCAL_DEVELOPMENT` is `"true"` and `SENTRY_DSN` is empty, on when `LOCAL_DEVELOPMENT` is anything else and `SENTRY_DSN` is set, and the callback throws on the two contradictions. The options trace every invocation except `GET /api/health`, which Sentry's uptime monitor checks ([sampling](../../docs/architecture/observability.md#sampling)). Cup code captures with `captureException` from `@sentry/core` directly; apart from the stuck-conversion and stuck-conversion-deletion reports, this library wraps no Sentry API.

[`captureAlarmFailure(pass)`](src/alarm-failure.ts) runs one pass of a Durable Object alarm, captures the error the pass throws and rethrows it, so the platform retries the alarm; every Durable Object's `alarm()` runs through it. [`captureStoppedWorkflow(workflow)`](src/stopped-workflow.ts) captures a preparation or segment Workflow instance that an owner's alarm found stopped without recording its own failure, and returns the event ID for a trial's `diagnosticReference`.

[`reportStuckConversions(candidates, owner, nowMs)`](src/stuck-conversion.ts) is the stuck-conversion check that the account and conversion grant alarms run: it sends one Sentry event for each candidate past its stage's threshold and returns the reported conversion IDs, which the owner stores so that it reports each stage once ([stuck checks](../../docs/architecture/observability.md#stuck-checks)). [`reportStuckConversionDeletions(candidates, nowMs)`](src/stuck-conversion-deletion.ts) does the same for the account alarm's marked conversions, reporting each one marked more than 1 h ago.

The options include the server `beforeSend` and `beforeSendSpan` from [`server-before-send.ts`](src/server-before-send.ts). `beforeSend` drops the events Sentry's Workflow and Durable Object wrappers capture on their own ([capture rule](../../docs/architecture/observability.md#capture-rule)). The hooks null the IP address, drop IP headers and the time zone, mask URLs with `@cup/telemetry.core`, and keep error messages only for Cup's own errors, by the rule of [`@cup/errors`](../errors/README.md). The options also set `beforeSendLog` from `@cup/telemetry.core`, which drops records below `info`.

[`logEvent(event, message, { attributes, error })`](src/log-event.ts) writes one log record of the [catalogue](../telemetry.core/src/log-events.ts) through `Sentry.logger`, at the event's fixed severity, with the event name as `event.name`. Pass details as `attributes` under `TELEMETRY_ATTRIBUTES` keys or semantic-convention names, never an email address, and a caught error as `error`: the record then carries its root cause as `exception.*` and the wrapper types as `cup.exception.chain`. Without an active Sentry client, as in local development and tests, it writes nothing. Tests of code that logs mock `logEvent` with `vi.mock` and assert on its calls.

[`logPreparationSettled`](src/conversion-outcomes.ts) and `logAudioSegmentSettled` write the [conversion outcome records](../../docs/architecture/observability.md#conversion-durations) for both conversion owners; `logAudioSegmentSettled` also writes `conversion-synthesis-settled` when the segment was the conversion's last reserved one.

[`setConversionScope({ conversionId, owner, sequence })`](src/conversion-scope.ts) puts the conversion's keys on the current invocation's isolation scope, so Sentry sends them as tags on errors and as attributes on spans and logs; call it once per entry point, as soon as it knows the conversion. `withConversionScope(context, callback)` does the same in a fork of the scope, for one iteration of an alarm that works through several conversions. The [observability page](../../docs/architecture/observability.md#correlation) lists the entry points.

## Telemetry tunnel

[`handleTelemetryTunnelRequest(request, { tunnelDsns, country })`](src/telemetry-tunnel.ts) forwards a client SDK's envelope to Sentry; the [API server](../../libs/api-server/src/api-server.ts) calls it for `POST /_/e` with the `SENTRY_TUNNEL_DSNS` var and `request.cf.country`. It answers a DSN outside `tunnelDsns` with a 403 and a body that is no envelope with a 400, removes the client IP headers, and stamps the country on `event` and `transaction` items ([envelope rewrite](src/tunnel-envelope.ts)). The [observability page](../../docs/architecture/observability.md#telemetry-tunnel) describes the rules.

## Tests

The unit tests cover the on/off table, the hooks and the envelope rewrite; the [Worker integration tests](../../apps/cloudflare-worker/test/telemetry-tunnel.test.ts) cover the tunnel against the Sentry stub. [`worker-sentry-pipeline.test.ts`](test/worker-sentry-pipeline.test.ts) runs the options through the real SDK against the [Sentry stub](../../qa/sentry-stub/README.md), for the wrapped foreign error that no Worker request path produces today; [`log-event.test.ts`](test/log-event.test.ts) does the same for a warning log with its root cause and exception chain.

Only this library and packages that depend on it may depend on `@sentry/cloudflare` ([SDK family check](../../qa/workspace-checks/README.md#sentry-sdk-family-check)); take `@sentry/cloudflare` and `@sentry/core` from the `sentry-server` catalog.

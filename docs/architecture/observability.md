# Observability

Cup reports production failures to Sentry through Sentry's own SDKs, and only from production. Cloudflare Workers Observability is off. [ADR 0029](../adr/0029-observe-production-with-sentrys-own-sdks-and-turn-cloudflares-observability-off.md) records why; the [spec](https://github.com/patricktree/cup/issues/403) describes the whole effort, of which these pages describe what is built:

- this page: what the Worker sends, the rules every runtime shares, and the alerts;
- [client observability](observability-clients.md): the web app, the mobile shells, crash reports and the telemetry tunnel;
- [observability operations](observability-operations.md): stuck checks, log records, conversion durations, going-live checks, and build and release tracking.

## What the Worker sends

Every Worker entry point, the `fetch` handler, each Durable Object class and both Workflows, is wrapped with `@sentry/cloudflare` in the [Worker entry](../../apps/cloudflare-worker/src/index.ts) and sends to the `cup-worker` project:

- **Errors**, by the [capture rule](#capture-rule), each tagged with the reporting entry point as `cup.component` and, when conversion-scoped, with the [correlation keys](#correlation).
- **Traces** of every request but the health check ([sampling](#sampling)). A request's trace continues into its Durable Object RPC calls, since Sentry carries the trace context across the Worker's own bindings. Durable Object SQL and storage spans are dropped, because they would outnumber all others.
- **Logs**: only Cup's own [log records](observability-operations.md#log-records).
- **The release**, the deployed Worker version; [release tracking](observability-operations.md#release-tracking) covers every runtime's release.

The web app and the shells send to a second project, `cup-app` ([client observability](observability-clients.md)). Sentry's projects, keys, privacy settings, alerts and monitors are managed in [Terraform](../../terraform/README.md#sentry).

## Capture rule

Cup calls `captureException` once, where an error stops propagating: where it becomes a 5xx response of the [API server](../../libs/api-server/src/api-server.ts), a failed [conversion outcome](../GLOSSARY.md#conversion-outcome), or a segment's final failure, or where a Durable Object alarm pass fails. An error that recurs is captured each time it reaches a capture point; only the [stuck checks](observability-operations.md#stuck-checks) report a case once.

- **Conversion failures** become issues tagged `cup.conversion.failure_category` (`segment` for a segment), including a Workflow instance that stopped without recording its failure, which the owner's alarm finds. A failed preparation's `diagnosticReference` is the event's ID. Issues keep Sentry's default grouping by the root cause's stack, so a new root cause in a known category is a new issue.
- **Workflow captures run inside a step** whose result the run records, so a replayed run does not capture again. The preparation captures before it asks the owner to record the outcome, so a failure is reported even when the owner cannot record it.
- **Expected outcomes are no issue**: a 4xx, a `content-limit` preparation failure and similar outcomes produce nothing or a warning log record.
- **Sentry's own wrappers capture too**, and the server `beforeSend` drops those events: the Workflow wrapper's for a step's failed attempt, which the run may still retry, and the Durable Object wrapper's for every thrown RPC or alarm error, which the RPC caller or the alarm's own capture reports at its boundary.

The [`@cup/telemetry.cloudflare` guide](../../libs/telemetry.cloudflare/README.md) names the capture helpers for alarms and stopped Workflows, and the [Worker integration tests](../../apps/cloudflare-worker/test/conversion-failures.test.ts) cover the rule against the [Sentry stub](../../qa/sentry-stub/README.md).

## Correlation

The conversion ID is the join key: every error, span and log of a conversion carries it as `cup.conversion.id`, so the operator can follow a conversion from the Listener API through Durable Object RPC and alarms into its Workflow steps. Each entry point puts it on Sentry's isolation scope once, as soon as it knows the conversion: a Listener API route, a Durable Object RPC method acting on one conversion, each iteration of an alarm that works through conversions (in a fork of the scope), and a Workflow run. Where the entry point knows the owner, the scope also carries the owner's kind and opaque ID, and a segment's work its sequence number; the [scope helpers](../../libs/telemetry.cloudflare/src/conversion-scope.ts) define the keys.

## Error references

Every error body of the Listener API and the Operator API carries `traceId`, the request's Sentry trace ID. Pasted into Sentry's search, it lands on the request's trace and on the error event of a 500. The web app shows it as "Reference" on its error screen and in a server failure's toast, and the [Operator CLI](../../apps/operator/README.md#use-machine-readable-output) prints it with each API failure. Every Worker log record carries the same trace ID, so a record needs no request ID of its own. Outside production the ID is still well formed and matches nothing.

## Sampling

The Worker traces every invocation, the web app's polls included, except `GET /api/health` ([sampler](../../libs/telemetry.cloudflare/src/worker-sentry-options.ts)). Sentry's uptime monitor checks that route every minute, and its near-empty traces would take about 43k spans a month of the free plan's quota. If span volume grows, a later change lowers the trace rate where little is lost, starting with the polls.

## Privacy

No runtime sends a listener's email address, IP address, headers, cookies, bodies, AI prompts or query data, and every runtime masks the values of credential query parameters with one shared function of [`@cup/telemetry.core`](../../libs/telemetry.core/README.md). On top of that:

- **The Worker** keeps the message only of Cup's own errors, those derived from `CupError` of [`libs/errors`](../../libs/errors/README.md): a foreign error anywhere in the `cause` chain, such as a database error that embeds SQL parameters, keeps only its class name. It also drops the time zone, a location finer than the country ([server hooks](../../libs/telemetry.cloudflare/README.md#use)).
- **The clients** keep only the user's opaque account ID, remove the device identifiers a native SDK copies onto JS events, and mask every breadcrumb, because breadcrumbs reach native events that pass no hook of Cup's ([client hooks](../../libs/telemetry.browser/README.md#use)). The [telemetry tunnel](observability-clients.md#telemetry-tunnel) replaces the IP address with the country.
- **Sentry's organisation settings** scrub again at ingest ([Terraform guide](../../terraform/README.md#privacy-settings)).

## Alerts and monitors

Sentry emails the operator, and nobody else, through the alerts in the [Terraform root](../../terraform/README.md#alerts-and-monitors), which also holds each threshold. Each email is Sentry's standard issue email with the issue's tags, such as `cup.conversion.id`.

- **New or regressed issues** of either project, which include client and native crash issues, the stuck checks, and the issues the uptime and volume monitors open.
- **Frequent conversion failures**: an issue tagged with a failure category that is seen often within an hour.
- **Uptime** of `GET https://cup.audio/api/health`, which answers 200 while the Worker runs and calls no binding.
- **Volume**: each project's daily errors and spans, each monitor set to a day's share of the free plan's monthly quota, so the operator learns before a quota runs out mid-month, after which alerting is blind until the next month. When one fires, the operator finds the source on Sentry's Stats page and fixes it; if the month is still at risk, adds a temporary inbound filter or drop; and if nothing is broken, lowers span sampling or upgrades. Spike protection is on in both projects.

Every alert emails at most once an hour per issue, and the operator's personal workflow notifications are off ([Terraform guide](../../terraform/README.md#personal-notifications)). A true failure-rate monitor, failed conversion outcomes divided by all outcomes, waits for volume or Sentry's Team plan.

## Nothing is sent outside production

The Worker decides per invocation from two plain vars: Sentry is on only when `LOCAL_DEVELOPMENT` is `"false"` and `SENTRY_DSN` is set, off when they are `"true"` and empty, and every request fails when they disagree, so a misconfigured environment neither sends from development nor stays quiet in production ([on/off rule](../../libs/telemetry.cloudflare/README.md#use)). Production's [`wrangler.jsonc`](../../apps/cloudflare-worker/wrangler.jsonc) holds the public `cup-worker` DSN; `pnpm dev` and the [test Worker](../../qa/test-worker/README.md) run with Sentry off. The [Worker integration tests](../../apps/cloudflare-worker/AGENTS.md#integration-tests) and the [registry tests](../../libs/registry/wrangler.test.jsonc) run Sentry as in production against an unreachable discard port, or against a [Sentry stub](../../qa/sentry-stub/README.md) when a test checks what reaches Sentry. The telemetry tunnel's allowlist is empty everywhere but production, so it forwards nothing unless a test allowlists a stub. The Worker's [config test](../../apps/cloudflare-worker/test/wrangler-config.test.ts) pins production's values.

The clients decide at runtime, because every web E2E suite runs the production bundle: the browser sends only from `https://cup.audio`, a release shell only against that API origin, and a debug shell only to a stub DSN the mobile E2E suite launches it with ([client on/off rule](observability-clients.md#on-or-off)). A shared [Playwright fixture](../../qa/sentry-stub/README.md#telemetry-request-guard) fails any app or source-material E2E test whose page requests a Sentry host or the tunnel.

## Telemetry libraries

Three libraries hold Cup's keys, options and privacy hooks; Cup code calls Sentry's API directly, with no wrapper around it:

- [`@cup/telemetry.core`](../../libs/telemetry.core/README.md), without an SDK, holds the `cup.*` attribute keys, the log event catalogue, URL masking and the DSNs;
- [`@cup/telemetry.cloudflare`](../../libs/telemetry.cloudflare/README.md) holds the Worker's options and hooks, `logEvent`, the scope helpers, the stuck reports and the tunnel;
- [`@cup/telemetry.browser`](../../libs/telemetry.browser/README.md) holds the clients' options and hooks, the user rule and the web release.

The server and client SDK families move on different majors, so a catalog pins each and the [workspace check](../../qa/workspace-checks/README.md#sentry-sdk-family-check) keeps them out of each other's packages. The client family moves only with a `@sentry/capacitor` release, which pins its own browser SDK.

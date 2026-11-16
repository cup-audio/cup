# Observability

Cup reports production failures to Sentry through Sentry's own SDKs, and only from production. Cloudflare Workers Observability is off. [ADR 0029](../adr/0029-observe-production-with-sentrys-own-sdks-and-turn-cloudflares-observability-off.md) records why; the [spec](https://github.com/patricktree/cup/issues/403) describes the whole effort, of which this page describes what is built.

## What the Worker sends

Every Worker entry point is wrapped with `@sentry/cloudflare` in the [Worker entry](../../apps/cloudflare-worker/src/index.ts): the `fetch` handler, the account, conversion grant and registry Durable Objects, and the preparation and audio segment synthesis Workflows. Each sends to the `cup-worker` project:

- **Errors**, captured once where they stop propagating, by the [capture rule](#capture-rule). Each event carries the `cup.component` tag, which names the entry point that reported it, and a conversion-scoped event also the [correlation keys](#correlation).
- **Traces**, every request except the health checks ([sampling](#sampling)), streamed span by span. A request's trace includes its Durable Object RPC calls: Sentry appends the trace context to each RPC call on the Worker's own Durable Object bindings, and the wrapped receiver removes it again. Durable Object SQL and storage spans are dropped, because they would outnumber all others.
- **Logs**, only Cup's own [log records](#log-records), at `info` and above.
- **The release**, the deployed Worker version from the `CF_VERSION_METADATA` binding, and the environment `production`.

Sentry's projects, keys, privacy settings, [alerts and monitors](#alerts-and-monitors) are managed in [Terraform](../../terraform/README.md#sentry); the two public DSNs are constants in `@cup/telemetry.core`.

## What the web app sends

In the browser on `https://cup.audio`, the web app reports through `@sentry/capacitor` with `@sentry/react` to the `cup-app` project, always through the [telemetry tunnel](#telemetry-tunnel) at the API origin. [`initializeTelemetry`](../../apps/web-app/src/telemetry.ts) starts it with the options of [`@cup/telemetry.browser`](../../libs/telemetry.browser/README.md); the [web app page](web-app.md#telemetry) describes where it hooks into the app.

- **Errors**: uncaught errors and unhandled rejections, render errors through a Sentry `ErrorBoundary` and React's error handlers, and the failures the web app captures where nothing awaits them. Failed requests, a Listener API 5xx included, are breadcrumbs only, since the Worker captured the server failure. Known browser noise, such as `ResizeObserver loop` and requests aborted by a navigation, is ignored.
- **Traces**, every page load and navigation, named after its TanStack Router route, with long animation frames, streamed span by span. Requests to the API origin carry Sentry's trace headers and join the Worker's trace; no other host receives them. Each trace links the previous one through session storage, which is session-scoped trace linking, not a telemetry identifier.
- **Sessions**, one per route.
- **Logs**: `enableLogs` is on, at `info` and above; the web app writes none yet.
- **The user** is the opaque account ID once signed in, and `signed-out` otherwise.
- **The release** `web@<hash>`, the first 16 hex digits of the SHA-256 of the entry chunk, which imports every other chunk by its hashed name. A Vite plugin of `@cup/telemetry.browser` writes it into the built `index.html` at build time, so it changes exactly when the bundle's code does, and Turbo can replay E2E suites that ran an unchanged bundle.

Sentry's Supabase integration adds spans and breadcrumbs of the auth client without query data; its auth-error events are dropped, because the web app handles those failures. Off: Zod errors, console capture, feedback, view hierarchy, profiling, CapacitorHttp tracing and replay.

## What the shells send

The Android and iOS shells run the same web app and the same `initializeTelemetry`, which there also starts Sentry's native SDK, Android's or Cocoa's, through `@sentry/capacitor`, so one `cup-app` project receives both ([ADR 0030](../adr/0030-capture-native-crashes-in-the-shells-without-consent-keeping-no-installation-id-on-the-device.md)).

- **JS errors, traces and logs** as in the browser, through the telemetry tunnel at the API origin with `makeFetchTransport`, which bypasses `CapacitorHttp`.
- **Native crashes** go straight from the native SDK to Sentry, reported on the next launch. Android also reports ANRs with thread dumps and memory-limiter kills; native crashes in C code arrive as Android's tombstones, and the NDK integration is off, because sentry-native stores an ID file of its own. Earlier crashes and ANRs from before the app's first launch with Sentry are not reported. iOS also reports app hangs, uncaught NSExceptions through its crash handler, and MetricKit diagnostics without raw payloads, with all threads attached.
- **Native traces**: activity or view-controller tracing with frames tracking is configured; user-interaction tracing is off, and on iOS network, file I/O and Core Data tracing too. The page starts the native SDK only after the activity or view controller exists, so neither shell sends native app-start spans: in the mobile E2E runs no native transaction arrived on either platform. The spec expects app start to ride on that span; whether and how the shells should start the native SDK earlier is open for the operator to decide, so this [going-live check](#going-live-checks) is unresolved.
- **The release** `audio.cup.app@<version>+<build>` with `dist` the build number, read through `App.getInfo()` before `Sentry.init`, so JS and native events share it. The web bundle's release is the tag `cup.web_release`.
- **The user** follows the same rule, and is set again once the native SDK runs, since a user set before then never reaches the native scope. ANR and tombstone events, reported from a later process, carry no account ID.
- **WebView process loss.** When the WebView's renderer (Android) or WebContent process (iOS) dies, the shell records it natively and brings the page back, and the reloaded web app sends one JS `error` event through the tunnel with a fixed fingerprint, so each platform has one issue: `webview-renderer-gone` tagged `cup.renderer.cause` (`crash` or `system-kill`) and `rendererPriorityAtExit`, or `webview-content-terminated`; both tagged `cup.app.state` `foreground` or `background`. The [mobile app guide](../../apps/mobile-app/README.md#webview-process-loss) describes the native side.

The native SDKs keep their installation ID in memory only. On Android, [`InMemoryInstallation`](../../apps/mobile-app/android/app/src/main/java/io/sentry/android/core/InMemoryInstallation.java) sets a random one per process before the page can start the SDK. On iOS, [`MainViewController`](../../apps/mobile-app/ios/App/App/MainViewController.swift) puts a directory where the Cocoa SDK would write its `INSTALLATION` file, so each process gets a new one; Cocoa sends it only as the user of an event that has none, and sends no device ID. Native session tracking is off on both, and Android's scope persistence and NDK and iOS's watchdog termination tracking too, so the SDKs keep no installation ID or session on the device, and release health for the shells is given up; a crash report waits on the device, with its scope, only until the next launch sends it. Screenshots, view hierarchies, feedback, replay and profiling are off. There is no native `beforeSend`: the organisation's scrubbing rule removes the device identifiers, including Cocoa's stable `contexts.app.device_app_hash`, and a `user.id` in an installation ID format at ingest. The [mobile app guide](../../apps/mobile-app/README.md#sentry) lists the native settings.

A listener can turn native capture off with the shells' ["Send crash reports" switch](#crash-reports-switch).

## Capture rule

Cup calls `captureException` once, where it turns an error into a 500 response, a failed conversion outcome or a finally failed segment, and nowhere else. An error that recurs is captured each time it reaches a capture point; only the [stuck checks](#stuck-checks) report a case once.

| Failure                                                                                                                                                                                                                              | Becomes                                                                                                                      |
| ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | ---------------------------------------------------------------------------------------------------------------------------- |
| Any 5xx of the [API server](../../libs/api-server/src/api-server.ts): Hono's `onError`, and each `catch` that answers `operational-error` with status 500                                                                            | Issue                                                                                                                        |
| A preparation failure in `source-preparation` or `content-selection`, captured in the [preparation runner](../../libs/create-audiobook-from-url-workflow/src/run-prepare-audiobook-workflow.ts) step that creates the failed outcome | Issue tagged `cup.conversion.failure_category` with the category; its event ID is the failed outcome's `diagnosticReference` |
| A segment's final failure, `PermanentNarrationSynthesisError` included, captured in the [segment runner](../../libs/create-audiobook-from-url-workflow/src/run-audio-segment-workflow.ts) step that releases its reservation         | Issue tagged `cup.conversion.failure_category` `segment`                                                                     |
| A stored audio segment that is missing or has the wrong size when the narration track is served                                                                                                                                      | Issue, beside the `narration-track-segment-mismatch` error log                                                               |
| A stuck case                                                                                                                                                                                                                         | Issue, by the [stuck checks](#stuck-checks)                                                                                  |
| A shell's WebView renderer gone (Android) or WebContent process terminated (iOS)                                                                                                                                                     | Issue, one per platform, by its fixed fingerprint ([what the shells send](#what-the-shells-send))                            |
| Any 4xx, a preparation failure in `content-limit`, and the other expected outcomes                                                                                                                                                   | Nothing, or a warning [log record](#log-records)                                                                             |

Conversion-failure issues keep Sentry's default grouping by the root cause's stack, so a new root cause in a known category is a new issue. Both captures run inside a Workflow step whose result the run records, so a replay of the run reuses the step's result instead of capturing again; the preparation's step captures before it asks the owner to record the finalization phase, so a failure is reported even when the owner cannot record it.

Sentry's own wrappers capture on their own too, and the server `beforeSend` drops those events by their mechanism:

- the Workflow wrapper captures a step's last failed attempt (`auto.faas.cloudflare.workflow`), though the run goes on: a retried attempt opens no issue, and only the instance's final failure, which Cup captures, does;
- the Durable Object wrapper captures every error an RPC method or the alarm throws (`auto.faas.cloudflare.durable_object`): an RPC error is captured by its caller at its boundary, a Durable Object captures only what it swallows itself, and each alarm captures its own failure with `captureAlarmFailure` before rethrowing it for the platform's retry. The stuck checks of both conversion owners run even when an earlier step of the pass threw.

The [Worker integration tests](../../apps/cloudflare-worker/test/conversion-failures.test.ts) cover a failed preparation, a finally failed segment, a failed RPC and a retried step against the Sentry stub.

## Correlation

The conversion ID is the join key: Cup's errors, spans and logs of one conversion carry it as `cup.conversion.id`, so the operator can follow a conversion from the Listener API through Durable Object RPC and alarms into its Workflow steps. Each entry point puts it on Sentry's isolation scope once with `setConversionScope` from `@cup/telemetry.cloudflare`; Sentry sends it as a tag on errors and as an attribute on spans and logs:

- a Listener API route, once it knows the conversion: the conversion routes' middleware, a conversion start, and a conversion deletion;
- a Durable Object RPC method that acts on one conversion;
- each iteration of a Durable Object alarm that works through conversions, in a fork of the scope (`withConversionScope`);
- a Workflow run.

Where the entry point knows the owner, the scope also carries `cup.owner.kind` (`account` or `grant`) and `cup.account.id` or `cup.conversion_grant.id`; a segment's synthesis and its alarm iteration carry `cup.audio_segment.sequence`. The Durable Object RPC methods set the conversion ID alone.

## Error references

Every error body of the Listener API and the Operator API carries `traceId`, the Sentry trace ID of the request: 32 hex characters, read from the request's active span in the [API server](../../libs/api-server/src/api-server.ts). Pasted into Sentry's search, it lands on the request's trace and on the error event of a 500, which carries the same trace ID. The web app shows it as "Reference" on the error screen and in the error toast of a server failure, and the [Operator CLI](../../apps/operator/README.md#use-machine-readable-output) prints it with each API failure. With Sentry off, outside production, the ID is still a well-formed trace ID that matches nothing.

Every Worker [log record](#log-records) carries the same trace ID as Sentry's own `trace_id` field, so a log record needs no request ID of its own; the `operator-mutation` record carries the method, path and status, and no email address.

## Sampling

The Worker traces every invocation, the web app's polls included, except `GET /api/health`. The `tracesSampler` in [`@cup/telemetry.cloudflare`](../../libs/telemetry.cloudflare/src/worker-sentry-options.ts) returns 0 for the request span whose `url.path` is `/api/health` and 1 for every other one. The health endpoint is a Listener API route that answers 200 while the Worker runs and calls no binding; Sentry's [uptime monitor](#alerts-and-monitors) checks it every minute, and its near-empty traces would take about 43k spans a month of the free plan's quota. If span volume grows, a later change lowers the trace rate where little is lost, starting with the polls.

## Stuck checks

A stuck check reports work that should have finished long ago as one Sentry error event per case, with a fixed fingerprint, so all cases land in one issue. A flag stored with the work keeps later passes from reporting the same case again.

- **Conversion stuck.** The account and conversion grant alarms run the [stuck-conversion check](conversion.md#stuck-conversions) on every pass. A conversion stuck in preparation or in synthesis sends one event per stage, with the fingerprint `["conversion-stuck", "preparation"]` or `["conversion-stuck", "synthesis"]`, so each stage is one issue. The event carries the tags `cup.conversion.id`, `cup.conversion.stage`, `cup.owner.kind`, and the opaque `cup.account.id` or `cup.conversion_grant.id`, plus `cup.conversion.phase`, the conversion phase it last started, for preparation; the `stuck_conversion` context holds the stage's age in minutes. The flag is a column of the conversion row, and starting a stage again clears it, so a retry that hangs again is reported again. A conversion that settles after its report sends nothing, and the operator resolves the issue by hand. The thresholds of 15 and 60 minutes are deliberately generous; tighten them once conversion durations are visible. The message names the conversion ID, so Sentry's Dedupe integration does not drop the next conversion's report as a repeat.
- **Conversion deletion stuck.** The account alarm runs the [stuck-conversion-deletion check](conversion-deletion.md#invariants) on every pass, right after the cleanup of marked conversions. A conversion still marked for deletion more than 1 h after it was marked sends one event with the fingerprint `["conversion-deletion-stuck"]`. It carries the tag `cup.conversion.id`, and `cup.component` from the account object's scope; the `stuck_conversion_deletion` context holds the age in minutes. It names no root cause: the per-pass `conversion-deletion-cleanup-failed` warnings hold that, and a cleanup that waits on an undrained artifact writer fails no pass, which is why the check measures age. The flag is the `deletion_stuck_reported_at_ms` column of the marked account conversion row, which goes with the row once the cleanup finishes. The message names the conversion ID, so Sentry's Dedupe integration does not drop the next conversion's report as a repeat.
- **Account deletion stuck.** The registry's [deletion coordinator](account-deletion.md#fencing-and-cleanup) checks every unfinished deletion attempt on each of its alarm passes. An attempt still neither erased nor restored 1 h after its recovery deadline is overdue, which means the same as stuck. Its event has the fingerprint `["account-deletion-stuck"]` and the tags `cup.account.id`, `cup.account_deletion.attempt_id` and `cup.account_deletion.pending`. The last names what is pending: `identity`, `account` or `both`, where the account fence counts as `account`. The flag is the `stuckReported` field of the attempt's job JSON, so it needs no migration. Retries back off to at most 1 h, so the report arrives at most about 2 h after the deadline. The Operator CLI's `overdue` uses the same threshold. The event's message names the attempt ID, so Sentry's Dedupe integration does not drop the report of a second stuck attempt as a repeat of the first.

## Alerts and monitors

Sentry emails the operator, and nobody else, through the alerts in the [Terraform root](../../terraform/README.md#alerts-and-monitors). Each email is Sentry's standard issue email, with the issue's title, culprit, environment, release and tags such as `cup.conversion.id`.

| Alert                        | Fires on                                                                                                                                  | Threshold                                         |
| ---------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------- |
| New or regressed issue       | A new issue, or a resolved one that comes back, in `cup-worker` or `cup-app`: server, client and native crash issues and the stuck checks | Every such issue                                  |
| Conversion failure frequency | A `cup-worker` issue tagged `cup.conversion.failure_category`                                                                             | Seen more than 5 times in 1 h                     |
| Uptime                       | Sentry's uptime monitor on `GET https://cup.audio/api/health`, in `cup-worker`                                                            | Checked every minute; issue after 3 failed checks |
| Error volume                 | A metric monitor per project on error and message events                                                                                  | More than 150 a day                               |
| Span volume                  | A metric monitor per project on spans                                                                                                     | More than 165,000 a day                           |
| Spike protection             | On in both projects, with Sentry's notification                                                                                           | Sentry's floor                                    |

- **One email per issue an hour.** Every alert's action interval is 1 h. The uptime and metric monitors open issues of their own, which the new-or-regressed alert of their project emails.
- **Only the alerts email.** The operator's personal workflow notifications are off, which only the Sentry UI can set ([Terraform guide](../../terraform/README.md#personal-notifications)).
- **The volume monitors are a day's share of the free plan's quota**, 5k errors and 5M spans a month, so the operator learns before a quota runs out mid-month. When one fires, the operator finds the source on Sentry's Stats page and fixes it; if the month is still at risk, adds a temporary inbound filter or `beforeSend` drop; and if nothing is broken, lowers span sampling or upgrades. Once a quota is used up, alerting is blind until the next month.
- A true failure-rate monitor, failed conversion outcomes divided by all outcomes, waits for volume or Sentry's Team plan.

## Going-live checks

These checks run once in production after the first deploy with Sentry, by the operator, and are not automated:

- `openai` spans carry no prompt or completion.
- `traceLifecycle: "stream"` works with `@sentry/capacitor` in the browser and both shells.
- Native app-start spans arrive on both platforms. **Unresolved:** the mobile E2E runs showed none on either platform, because the page starts the native SDK only after the first activity or view controller exists ([what the shells send](#what-the-shells-send)). Whether to accept that or start the native SDK earlier is the operator's open question.
- Cocoa keeps or drops query strings in network breadcrumbs, and the organisation's masking rule covers what it keeps.
- The Terraform provider works end to end against the Germany-region organisation: an apply of the [Sentry root](../../terraform/README.md#sentry) creates every alert and monitor, and a second plan shows no changes.
- The organisation and `cup-worker` scrubbing rules work, the first plan's drift checks pass, and an event in Sentry shows the country only.
- On iOS, the [WebContent check](../../apps/mobile-app/README.md#ios-webcontent-check) passes.
- One forced error per project reaches production Sentry and emails the operator, and the uptime monitor shows `/api/health` green.

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
| `info`   | lifecycle events and outcomes | `operator-mutation`, and the [conversion outcomes](#conversion-durations) `conversion-preparation-settled`, `audio-segment-settled`, `conversion-synthesis-settled`                                                                                                                                       |
| `debug`  | never sent                    | none                                                                                                                                                                                                                                                                                                      |

The catalogue, [`log-events.ts`](../../libs/telemetry.core/src/log-events.ts), describes when each event is written. An expected outcome is a warning, not an issue. Rename an event only together with the saved queries and alerts that use it. The per-pass warnings of [conversion deletion](conversion-deletion.md) and [account deletion](account-deletion.md#fencing-and-cleanup) carry the root cause, so a stalled deletion can be investigated by conversion or account ID.

Outside production, Sentry is off and `logEvent` writes nothing, also not to the console.

## Conversion durations

The operator sees how long conversions take and how they end from three `info` [log records](#log-records), which the owning account or conversion grant Durable Object sends when it records the outcome, and from the Workflow step spans. Each record carries `cup.conversion.id`; a replayed outcome sends nothing.

- `conversion-preparation-settled`: `cup.conversion.outcome` is `ready`, `failed` with `cup.conversion.failure_category`, or `insufficient-duration` for a prepared document whose segments did not fit the available duration. `cup.conversion.elapsed_ms` is the time from the conversion's creation, so after a retry it includes the failed preparation and the wait before the retry.
- `audio-segment-settled`: `cup.audio_segment.outcome` is `settled` or `released`, with `cup.audio_segment.sequence`, `cup.audio_segment.synthesis_ms` from the segment's reservation, and `cup.audio_segment.attempts`, the synthesis attempts of the segment's Workflow run, rate-limited ones included. A release by the owner's alarm, or by a run replayed after its last synthesis attempt, has no attempt count.
- `conversion-synthesis-settled`: sent with the segment record that leaves no segment of the conversion reserved. `cup.conversion.failed_segments` counts the released segments; with none, `cup.conversion.elapsed_ms` is the time from the conversion's creation until its narration track exists. A retry that reserves segments again sends it again when they settle.

Sentry's Workflow wrapper makes every step a span named after the step, and each Cup step's name starts with its [conversion phase](../GLOSSARY.md#conversion-phase), as in `finalization: record conversion ready` or `audio-segment-production: synthesize and settle audio segment`, so a trace shows the time each phase takes. Cloudflare Workflows keys a step's stored result by its name: a deploy that renames a step makes an instance running at that moment run the step again. The [registry's outcome tests](../../libs/registry/test/conversion-outcomes.test.ts) cover both owners' records, and the [Worker integration tests](../../apps/cloudflare-worker/test/conversion-failures.test.ts) the step span names and a real run's attempt count.

## Telemetry libraries

| Library                                                                  | Runtime     | Holds                                                                                                                                                                                                                                                                                        |
| ------------------------------------------------------------------------ | ----------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| [`@cup/telemetry.core`](../../libs/telemetry.core/README.md)             | any, no SDK | The `cup.*` attribute keys, the log event catalogue and the `beforeSendLog` severity filter, URL masking and the masking `beforeSendSpan`, the signed-out user, and both production DSNs                                                                                                     |
| [`@cup/telemetry.cloudflare`](../../libs/telemetry.cloudflare/README.md) | Workers     | The Worker's Sentry options with the on/off rule, the server `beforeSend` and `beforeSendSpan`, the typed log-event helper `logEvent` and the conversion outcome records, the stuck-conversion and stuck-conversion-deletion reports, the conversion scope helpers, and the telemetry tunnel |
| [`@cup/telemetry.browser`](../../libs/telemetry.browser/README.md)       | DOM         | The client's Sentry options with the on/off rules of the browser and the shells and the shells' release, the client `beforeSend` and `beforeBreadcrumb`, the user rule, and the web release                                                                                                  |

Cup code calls Sentry's API directly, such as `captureException` from `@sentry/core` or `@sentry/react`; the libraries hold keys, options, privacy hooks and the log-event helper, not a wrapper around Sentry. The server and client SDK families move on different majors, so the `sentry-server` and `sentry-client` catalogs in `pnpm-workspace.yaml` pin each family, and the [workspace check](../../qa/workspace-checks/README.md#sentry-sdk-family-check) keeps the families out of each other's packages. The client family moves only with a `@sentry/capacitor` release, which pins its own `@sentry/browser` and peers on exactly one `@sentry/react`.

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
- keep the messages only of Cup's own errors. A foreign error anywhere in the captured `cause` chain, such as a Drizzle query error that embeds SQL parameters, keeps its class name as its type and loses its message and the properties `extraErrorDataIntegration` copied from it. Cup's own errors are those derived from `CupError` of [`libs/errors`](../../libs/errors/README.md); a plain `Error` is foreign, since a dependency can throw one.

The client options set `sendDefaultPii: false` and leave `dataCollection` unset, since setting any of its keys makes the others permissive. The client `beforeSend` and `beforeBreadcrumb` in `@cup/telemetry.browser` then:

- keep only the user's ID and set its IP address to null; the tunnel strips the IP headers and keeps only the country;
- remove the device identifiers `contexts.device.id` and `contexts.app.device_app_hash`, which a native SDK copies onto JS events;
- mask credential query parameters with the same function, in URLs, messages, exception values and every breadcrumb, because scope sync copies breadcrumbs onto native events, which pass no `beforeSend` of Cup's;
- drop the auth errors of Sentry's Supabase integration.

The masking `beforeSendSpan` and `beforeSendLog` of `@cup/telemetry.core` apply to the client too. Sentry's organisation settings scrub again at ingest; the [Terraform guide](../../terraform/README.md#sentry) describes them.

### Crash reports switch

The shells' account settings have a "Send crash reports" switch, on by default; the browser has none. It covers native capture only: the shell's JS errors, traces and logs still go through the tunnel. The shells' own `CrashReporting` plugin keeps it in SharedPreferences on Android and in UserDefaults on iOS, never in `localStorage`, and `initializeTelemetry` reads it before `Sentry.init` and passes it as `enableNative`. Turning it off deletes Sentry's files on the device: `cache/sentry/` on Android, and `io.sentry/`, `SentryCrash/` and `async.log` in `Library/Caches` on iOS. The native SDK of the running process keeps running until the app stops, so the switch takes full effect on the next start, which runs JS-only and deletes whatever that SDK wrote after the switch; there is no live re-init. Crashes of listeners who turned it off reach only the store consoles ([ADR 0030](../adr/0030-capture-native-crashes-in-the-shells-without-consent-keeping-no-installation-id-on-the-device.md)). The [mobile app guide](../../apps/mobile-app/README.md#crash-reports-switch) describes the plugin.

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

The web app decides at runtime, because every web E2E suite runs the production bundle: the browser sends only when the page's origin is exactly `https://cup.audio`, so local development, the component tests and the E2E suites start no Sentry at all. A release shell sends only when its API origin is `https://cup.audio`. A debug shell, which the web app recognises by the `Capacitor.DEBUG` flag the native side sets, sends nothing unless the [mobile E2E suite](../../qa/mobile-e2e/README.md#telemetry) launches it with a Sentry stub's DSN as `cupTestSentryDsn`, and then sends only to that DSN; a shell that does not say it is a release build counts as a debug build. A shared [Playwright fixture](../../qa/sentry-stub/README.md#telemetry-request-guard) in the app and source-material E2E suites fails any test whose page requests a `*.sentry.io` host or `/_/e`, so a regression of that rule fails the suites.

## Build

The Worker's [Vite configuration](../../apps/cloudflare-worker/vite.config.ts) adds Sentry's Vite plugin for build-time instrumentation only. The Worker entry wraps the entry points itself instead of leaving that to the plugin's auto-instrumentation, because the Worker integration tests run the entry through Wrangler's test harness, which bundles without Vite, and must run the same wrapping as production. Cloudflare receives no source maps (`upload_source_maps: false`).

## Release tracking

Every event names its release (the Worker version, `web@<hash>`, or a shell's `audio.cup.app@<version>+<build>` with the web release as the tag `cup.web_release`), and every Worker and web app stack trace resolves to Cup's source lines through source maps that the deploy uploads before the release goes live.

- **Debug IDs, not releases, match a stack trace to its source map.** The web app and the Worker build with `build.sourcemap: "hidden"`, so no chunk names its map. Each package's `turbo:build` then runs [`prepare-source-maps`](../../tooling/source-maps/README.md), which runs `sentry-cli sourcemaps inject` to write a debug ID into every chunk and its map, and moves every `.map` file into `dist/source-maps`. Neither the Worker's static assets nor `cap sync` ship a map. Sentry CLI derives each debug ID from the file's content, so the build stays deterministic and Turbo replays it on unchanged inputs.
- **The deploy uploads, then deploys.** The Worker's [deploy script](../production-configuration.md#deploy) checks Sentry auth, builds, uploads the web app's maps to `cup-app` and the Worker's to `cup-worker`, and only then runs `wrangler deploy`; any failure aborts it. It makes no release API calls: events create their releases. `@sentry/vite-plugin`'s upload is not used, and neither is the Cloudflare Vite plugin's.
- **A native release uploads before the store upload.** The shells' JS events need the source maps of the web bundle packed into each build, and iOS crashes the dSYMs of its archive. The mobile app's `symbols:upload` uploads both after a release archive and fails loudly, which blocks the store upload ([native release](../production-configuration.md#native-release)). Android has no native debug files to upload while it is unminified and without the NDK.
- **The upload token stays out of every checkout.** It lives in `~/.sentryclirc` from `sentry-cli login`; the committed [`.sentryclirc`](../../.sentryclirc) names only the organisation and the Germany region, a [deploy test](../../apps/cloudflare-worker/test/deploy.test.ts) pins that, and `pnpm env:check` rejects a token in an environment file. No test calls Sentry: the tests run Sentry CLI without a token against a local discard port, or with a fake token against a local server that fails every upload.

The [build output test](../../apps/cloudflare-worker/test/web-app-build-output.test.ts) checks that the served web output holds no `.map` file and that every chunk carries a debug ID its map shares.

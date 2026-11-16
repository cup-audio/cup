# Observability

Cup reports production failures to Sentry through Sentry's own SDKs, and only from production. Cloudflare Workers Observability is off. [ADR 0029](../adr/0029-observe-production-with-sentrys-own-sdks-and-turn-cloudflares-observability-off.md) records why; the [spec](https://github.com/patricktree/cup/issues/403) describes the whole effort, of which this page describes what is built.

## What the Worker sends

Every Worker entry point is wrapped with `@sentry/cloudflare` in the [Worker entry](../../apps/cloudflare-worker/src/index.ts): the `fetch` handler, the account, conversion grant and registry Durable Objects, and the preparation and audio segment synthesis Workflows. Each sends to the `cup-worker` project:

- **Errors**, captured once where Cup turns an error into a 500 response: Hono's `onError`, and each `catch` in the [API server](../../libs/api-server/src/api-server.ts) that answers `operational-error` with status 500. A 4xx response captures nothing. Each event carries the `cup.component` tag, which names the entry point that reported it.
- **Traces**, every request at a sample rate of 1, streamed span by span. A request's trace includes its Durable Object RPC calls: Sentry appends the trace context to each RPC call on the Worker's own Durable Object bindings, and the wrapped receiver removes it again. Durable Object SQL and storage spans are dropped, because they would outnumber all others.
- **Logs**, only Cup's own [log records](#log-records), at `info` and above.
- **The release**, the deployed Worker version from the `CF_VERSION_METADATA` binding, and the environment `production`.

Sentry's projects, keys and privacy settings are managed in [Terraform](../../terraform/README.md#sentry); the two public DSNs are constants in `@cup/telemetry.core`. The `cup-app` project for the web app and the shells exists, but nothing sends to it yet.

Planned by the spec and not built yet: the conversion outcome `info` events, the `cup.conversion.id` join key on every conversion-scoped record, `traceId` in error bodies, captures in the Durable Objects and Workflows, the stuck checks, alerts and monitors, the telemetry tunnel, client telemetry in the web app and the shells, `/api/health`, and source map upload.

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

| Library                                                                  | Runtime     | Holds                                                                                                                                                                                    |
| ------------------------------------------------------------------------ | ----------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| [`@cup/telemetry.core`](../../libs/telemetry.core/README.md)             | any, no SDK | The `cup.*` attribute keys, the log event catalogue and the `beforeSendLog` severity filter, URL masking and the masking `beforeSendSpan`, the signed-out user, and both production DSNs |
| [`@cup/telemetry.cloudflare`](../../libs/telemetry.cloudflare/README.md) | Workers     | The Worker's Sentry options with the on/off rule, the server `beforeSend` and `beforeSendSpan`, and the typed log-event helper `logEvent`                                                |

Cup code calls Sentry's API directly, such as `captureException` from `@sentry/core`; the libraries hold keys, options, privacy hooks and the log-event helper, not a wrapper around Sentry. The server and client SDK families move on different majors, so the `sentry-server` catalog in `pnpm-workspace.yaml` pins the server family, and the [workspace check](../../qa/workspace-checks/README.md#sentry-sdk-family-check) keeps the families out of each other's packages.

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

| Configuration                                                                        | `LOCAL_DEVELOPMENT` | `SENTRY_DSN`                                                                                             |
| ------------------------------------------------------------------------------------ | ------------------- | -------------------------------------------------------------------------------------------------------- |
| Production ([`wrangler.jsonc`](../../apps/cloudflare-worker/wrangler.jsonc))         | `"false"`           | the `cup-worker` DSN                                                                                     |
| `pnpm dev` after `pnpm dev:services`                                                 | `"true"`            | empty, written by the helper                                                                             |
| [Test Worker](../../qa/test-worker/README.md)                                        | `"true"`            | empty                                                                                                    |
| [Worker integration tests](../../apps/cloudflare-worker/AGENTS.md#integration-tests) | `"false"`           | `http://test@127.0.0.1:9/1`, a discard port, or the Sentry stub's DSN through `useWorker({ sentryDsn })` |

The Worker's [config test](../../apps/cloudflare-worker/test/wrangler-config.test.ts) and the test Worker's config test pin these values. Tests that check what reaches Sentry start a [Sentry stub](../../qa/sentry-stub/README.md), which records envelopes and forwards nothing.

## Build

The Worker's [Vite configuration](../../apps/cloudflare-worker/vite.config.ts) adds Sentry's Vite plugin for build-time instrumentation only. The Worker entry wraps the entry points itself instead of leaving that to the plugin's auto-instrumentation, because the Worker integration tests run the entry through Wrangler's test harness, which bundles without Vite, and must run the same wrapping as production. Cloudflare receives no source maps (`upload_source_maps: false`).

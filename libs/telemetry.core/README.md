# Telemetry core

Cup's telemetry vocabulary and privacy helpers for every runtime, without a Sentry SDK, so that the Worker's and the clients' telemetry libraries share them. The [observability page](../../docs/architecture/observability.md) describes how they are used.

- [`TELEMETRY_ATTRIBUTES`](src/telemetry-attributes.ts): Cup's own `cup.*` keys, such as `cup.conversion.id` and `cup.component`. Use these constants instead of string literals, and a semantic-convention name where one exists.
- [`LOG_EVENTS`](src/log-events.ts) is the catalogue of log event names, each with its fixed severity (`error` must look, `warn` degraded but handled, `info` lifecycle and outcomes, `debug` never sent); `LOG_ATTRIBUTES` names the event and exception attributes. Add an event here before logging it with `logEvent` from `@cup/telemetry.cloudflare`.
- `beforeSendLog` drops log records below `info` and masks URLs in the message and string attributes.
- [`maskUrl`](src/url-masking.ts) masks the values of the credential query parameters in `MASKED_QUERY_PARAMETERS` (`token`, `key`, `sig`, `signature`, `auth`, `code`, `access_token`) in a URL, a query string or text that contains URLs, and keeps the rest readable. Every privacy hook uses this one function.
- `maskSpanUrls` is a `beforeSendSpan` for streamed spans: it masks the span name and every string attribute.
- `SIGNED_OUT_USER` is the telemetry user of a listener who is not signed in. Clients set it instead of `setUser(null)`, which would let a native SDK fill in its installation ID.
- [`CUP_WORKER_DSN` and `CUP_APP_DSN`](src/sentry-dsns.ts) are the public DSNs of the two Sentry projects, copied from the Terraform outputs of `terraform/sentry` ([DSN handover](../../terraform/README.md#dsn-handover)). Only production configuration uses them.

This library has no runtime dependencies, so a package of either Sentry SDK family can depend on it.

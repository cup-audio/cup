---
status: accepted
---

# Observe production with Sentry's own SDKs and turn Cloudflare's observability off

Before the public launch the operator learned of a failure only when a listener reported it: the Worker wrote a few `console.*` lines into Cloudflare Workers Observability, the web app and the shells reported nothing, and nothing sent an alert. The map [Observability and APM](https://github.com/patricktree/cup/issues/337) for Linear CUP-37 chose how Cup observes production; [Which backend and alert channel?](https://github.com/patricktree/cup/issues/342) settled it with the operator on 2026-11-14, and the [spec](https://github.com/patricktree/cup/issues/403) describes the build. Ticket [#405](https://github.com/patricktree/cup/issues/405) implemented the Worker's part first, and pull request [#422](https://github.com/patricktree/cup/pull/422) implemented the whole decision.

## Decision

- **Sentry is the one backend** for errors, traces, logs, native crashes and uptime, on its free Developer plan in its Germany region. Alerts reach the operator by email only.
- **Cup uses Sentry's own SDKs, with no OpenTelemetry layer:** `@sentry/cloudflare` in the Worker, its Durable Objects and its Workflows, and one `@sentry/capacitor` with `@sentry/react` bundle in the web app and the shells. Cup code calls Sentry's API directly; small libraries (`@cup/telemetry.*`) hold the keys, options and privacy hooks.
- **Cloudflare Workers Observability is off:** no invocation logs, Workers Logs, traces or Issues, and no source maps uploaded to Cloudflare. Nothing is exported over OTLP.
- **Nothing is sent outside production.** The Worker's `SENTRY_DSN` must agree with `LOCAL_DEVELOPMENT`, or every invocation throws; tests send to a local Sentry stub.

## Considered options

- **An OpenTelemetry layer exporting OTLP to a backend.** [Which OTLP backends fit Cup?](https://github.com/patricktree/cup/issues/339) and [Do the shortlisted backends handle Cup's OTLP data end to end?](https://github.com/patricktree/cup/issues/346) found that no backend handles OTLP data alone: Sentry creates no issues from OTLP and drops span events, only Uptrace applies source maps to OTLP exceptions, and native crash symbolication needs a vendor's native SDK whatever the backend. An OTLP layer would therefore still need a vendor SDK in the shells, while losing grouping, releases and source maps on the server.
- **Grafana Cloud, New Relic, Uptrace or Better Stack as the backend.** Each lacked one of: grouped "new error type" alerts on Cup's data, an EU region on the free tier, source maps, or native crash symbolication (#339, #346). Sentry has all of them through its SDKs.
- **Cloudflare Workers Observability as the backend.** It covers only the Worker: no client errors, no native crashes, no grouping into issues with alerts, no uptime checks.
- **Phone push alerts.** Push would need another app or service next to Sentry ([#342](https://github.com/patricktree/cup/issues/342)); email meets the operator's need before launch.

## Consequences

- Cup depends on Sentry's SDKs in every runtime, and the server and client SDK families move on different majors. Separate pnpm catalogs and a workspace check keep them apart.
- The Worker's entry points are wrapped in code, not by the Sentry Vite plugin's auto-instrumentation, because the Worker integration tests bundle the entry without Vite and must run the same wrapping as production.
- Privacy is enforced in Cup's hooks and again by Sentry's organisation scrubbing rules, which Terraform manages. Foreign error messages, such as Drizzle's with their SQL parameters, never leave the Worker.
- The [observability page](../architecture/observability.md) describes what is built.

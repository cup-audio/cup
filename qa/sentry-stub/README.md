# Sentry stub

Tests that exercise Sentry use this stub (`@cup/sentry-stub`): a local stand-in for Sentry's envelope endpoint that records every envelope it accepts and forwards nothing. Start one per test with `useSentryStub({ onTestFinished })` from [`src/sentry-stub.ts`](src/sentry-stub.ts).

- `dsn("cup-worker")` or `dsn("cup-app")` is a DSN for one of the stub's two projects; pass it to the code under test, such as `useWorker({ sentryDsn })` in the [Worker integration tests](../../apps/cloudflare-worker/AGENTS.md#integration-tests).
- `envelopes` holds each accepted envelope with its project, public key, HTTP request headers, envelope header and parsed items. `errorEvents(project)`, `spans(project)` and `logs(project)` return the error events, streamed spans and log records of one project.
- Sentry sends after the response, at the end of the invocation, so wait before asserting: `waitFor(description, condition)` resolves once `condition` holds and fails after 10 seconds. To assert that nothing was captured, wait for something the same flush sends, such as the request's `http.server` span.
- A request for another project or path answers 404 and is not recorded.

The stub models the envelope format of Sentry's developer docs as read on 2026-11-16; it does not check the DSN's key or rate-limit. Unlike the [Resend stub](../resend-stub/README.md), it has no live contract test.

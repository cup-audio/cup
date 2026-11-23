---
status: accepted
---

# Stand in for Resend and Sentry with local HTTP stubs

Tests must exercise deletion notices and error reporting without sending real email or real events. The Resend stub and its opt-in live contract test came with [#37](https://github.com/cup-audio/cup/pull/37); the Sentry stub and the telemetry request guard came with Sentry reporting in [#422](https://github.com/cup-audio/cup/pull/422) (issue [#403](https://github.com/cup-audio/cup/issues/403)). These decisions were recorded from code comments on 2026-11-23.

## Decision

Both stubs are `node:http` servers, one instance per test on 127.0.0.1 and an OS-assigned port, so a test file's tests can run concurrently. Each offers a start helper that closes the stub when the test finishes; it takes `onTestFinished` from the test's own context, so concurrent tests each close their own stub. Closing the Resend stub closes every connection first, since hung and held requests would otherwise keep `close()` waiting forever.

The [Resend stub](../../qa/resend-stub/src/resend-stub.ts) stands in for `POST /emails`. By default it models Resend's documented request checks and idempotency with a ledger keyed by `Idempotency-Key`; a test can script, hang or hold the next requests' answers instead. The modeled behaviour follows Resend's docs as read on 2026-10-20:

- [API introduction](https://resend.com/docs/api-reference/introduction): requests without a `User-Agent` header are refused with 403. `fetch` always sends a User-Agent, so the stub's test sends such a request through `node:http`. For the same reason the live contract test sends its request without a User-Agent through `node:https`.
- [Idempotency keys](https://resend.com/docs/dashboard/emails/idempotency-keys): keys are 1 to 256 characters and kept for 24 hours; a replay with the same body returns the original response without sending again, a replay with a modified body answers `409 invalid_idempotent_request`, and a replay while the first request is in progress answers `409 concurrent_idempotent_requests`.
- [Errors](https://resend.com/docs/api-reference/errors): the `{ statusCode, name, message }` shape.

Where the docs are silent the stub picks one reading: the 24 hours count from the first request, an expired key sends again, "modified" compares parsed JSON, and a refused request leaves no trace on its key.

A hold models a send whose response is lost. Without a scripted response the held request runs through the ledger: its key is in flight while held (by the time the hold resolves as arrived), and the email is sent on release even when the client has given up by then. With a scripted response it is answered that way on release and sends nothing. A held replay checks the ledger again on release, because the first request may have finished meanwhile. A client that gave up, such as one whose timeout fired during a hold, gets no answer.

The [live contract test](../../qa/resend-stub/test-live/resend-idempotency.test.ts) checks what no local test can: that the stub's model matches the real API. It is opt-in through `pnpm test:resend-live` and part of no validation command ([vitest.config.ts](../../qa/resend-stub/vitest.config.ts) leaves `test-live/` out). Every test sends real emails, to `delivered@resend.dev` only, under a fresh idempotency key. [Its config](../../qa/resend-stub/vitest.live.config.ts) never retries, because a retry would send more real emails and could hide a contract mismatch, and allows for each test making a few real HTTPS requests.

The [Sentry stub](../../qa/sentry-stub/src/sentry-stub.ts) stands in for Sentry's envelope endpoint. It accepts envelopes for Cup's two projects, records them and answers as Sentry does, so a test can assert what would have reached Sentry, or that nothing did; it forwards nothing. The envelope format follows [Sentry's developer docs](https://develop.sentry.dev/sdk/data-model/envelopes/) as read on 2026-11-16: a JSON header line, then items, each a JSON item header line followed by a payload that is `length` bytes long when the item header declares a length and runs to the next newline otherwise. A newline may also follow a payload of declared length. SDKs post envelopes to `/api/{projectId}/envelope/` with the DSN's public key in the `sentry_key` query parameter. The native Android SDK compresses its envelopes, so the stub decompresses them.

The [telemetry request guard](../../qa/sentry-stub/src/telemetry-request-guard.ts) is an automatic Playwright fixture that fails every test whose pages request one of Sentry's hosts or the telemetry tunnel on any origin, so a regression in the web app's on/off rule fails the web E2E suites. It watches every browser context the test opens, the `page` fixture's and those of `browser.newPage()` alike, by shadowing the prototype's method for the test, and records requests before any route answers or aborts them. A suite extends its `test` with it.

## Consequences

- The Resend model can drift from the real API between live runs; only the operator runs the live test, since it sends real email.
- Sentry's envelope format is parsed by hand and must follow changes in Sentry's docs and SDKs.
- No web E2E test can make a request to Sentry or the tunnel without failing.

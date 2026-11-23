---
status: accepted
---

# Run E2E suites against a local test Worker over HTTPS with a fake Supabase Auth

The web and mobile E2E suites need the real Worker and a real sign-in flow, but no Google traffic, no real speech provider and no mail. The test Worker harness and its fake auth provider grew with the app E2E suite in WebKit ([#198](https://github.com/cup-audio/cup/pull/198)), the mobile E2E suite ([#211](https://github.com/cup-audio/cup/pull/211)), iOS sign-in through a system browser sheet ([#227](https://github.com/cup-audio/cup/pull/227)), sign-in from the home page ([#256](https://github.com/cup-audio/cup/pull/256)), the Resend stub ([#37](https://github.com/cup-audio/cup/pull/37)), Sentry reporting ([#422](https://github.com/cup-audio/cup/pull/422), issue [#403](https://github.com/cup-audio/cup/issues/403)), the native Android media player ([#401](https://github.com/cup-audio/cup/pull/401), issue [#392](https://github.com/cup-audio/cup/issues/392)) and the faster validation gates ([#312](https://github.com/cup-audio/cup/pull/312)). These decisions were recorded from code comments on 2026-11-23.

## Decision

HTTPS:

- Each test's Worker serves HTTPS with a self-signed certificate for `127.0.0.1` that the [global setup](../../qa/e2e/test-e2e/https-certificate.global-setup.ts) creates, so it serves HTTPS as production does. The grant session cookie carries the `__Secure-` prefix, and WebKit stores such a cookie only from an HTTPS response, even on a loopback address where Chromium accepts it over HTTP.
- The browsers skip certificate checks (`ignoreHTTPSErrors` in [the Playwright config](../../qa/e2e/playwright.config.ts)). The tests' own requests trust the certificate through `NODE_EXTRA_CA_CERTS`, which Node reads when a worker process starts; Playwright starts the workers after global setup with its environment. Any caller of the [harness](../../qa/test-worker/src/test-worker.ts) that serves HTTPS, including its own readiness check and grant creation, must trust the certificate this way.
- The fake auth provider serves HTTPS with the same key and certificate in the web suite, because WebKit blocks an HTTPS page from calling HTTP.

The [fake auth provider](../../qa/test-worker/src/auth-provider.ts) is the local identity boundary: real PKCE, a Google ID token exchange with Supabase's nonce check, the test account's password sign-in, signed access tokens and JWKS, with no Google traffic. It mirrors Supabase where the app depends on it:

- Supabase fills `name` from Google's ID token; the web app shows its initials ("rd" for "Reader Doe") in the avatar.
- A session keeps the sign-in it belongs to across refreshes, as Supabase keeps a session's `amr`: a password sign-in is the test account's, any other the Google account's.
- Every refresh token issued is kept after its single use, with the session that use issued, so a reuse within Supabase's default `refresh_token_reuse_interval` (which [supabase/config.toml](../../supabase/config.toml) keeps) gets that session again, and a later reuse is told apart from a typo.
- The [session refresh test](../../qa/e2e/test-e2e/accounts.test.ts) issues access tokens that live 2 seconds: short enough that a session outlives several access tokens within one test. supabase-js refreshes before every request once a token expires within 90 seconds, so any lifetime below that behaves alike. One second is too short: `exp` counts whole seconds, so a token issued late in a second could expire before the Worker checks it. The test waits a margin past expiry that covers the Worker's clock, which advances only between requests and trails the test's clock, and `jose` treats a token as expired from its `exp` second.
- It answers with the 400 error body Supabase Auth sends: the API version 2024-01-01 shape when the client asks for it, as supabase-js does, and the legacy shape otherwise.
- Its host is `localhost`, also in its token issuer, and it listens on one port at both `127.0.0.1` and `::1`, so `localhost` reaches it however a client resolves it. It tries another port when the one assigned on IPv4 is taken on IPv6.
- As Supabase does, it accepts a Google ID token only when it carries the SHA-256 hash of the raw nonce. For the mobile apps it stands in for Google's sign-in sheet, returning a Google ID token that carries the hashed nonce the app passed to the sign-in plugin.
- A refresh token's reuse within the reuse interval, 10 seconds by default as in Supabase, returns the session the first use issued, such as when a page reloads during a refresh and its storage still holds the old token; a later reuse is rejected. A test can shorten the interval to see a later reuse rejected.
- supabase-js reads an error's code from the shape the API version header names, also in a browser, so the provider honours that header.
- It sends a code only to a page of the web suite's app on `127.0.0.1` or to the iOS app's callback URL, which its `ASWebAuthenticationSession` catches.

The test Worker:

- Its [Wrangler config](../../qa/test-worker/wrangler.jsonc) sends nothing to Sentry, as local development does, and [a test](../../qa/test-worker/test/wrangler-config.test.ts) pins these values; a suite allowlists a Sentry stub DSN for the telemetry tunnel with `--var`. Resend's base URL is an unreachable discard port, so deletion notices never reach Resend.
- The harness reads the requests the Worker entry logs by a prefix that must match the one `logRequest` writes in the [Worker entry](../../qa/test-worker/worker/worker.ts). The entry writes one line per request to Wrangler's output; a POST or PUT also logs its body, read from a clone so the API still reads the original. The speech controls are served only by this isolated QA Worker.
- Options make time-dependent behaviour testable: the API server honours the short signed URL lifetime only with `LOCAL_DEVELOPMENT`, which the Worker's config sets; signed media and position URLs can expire seconds after the Worker hands them out instead of after at least a day, so a test sees them expire; narration tracks can be sent at a set number of bytes per second instead of at loopback speed, so a player buffers only part of the track and a lost connection fails a request while it plays; as it does over a mobile network (at loopback speed the client holds the whole track within a second); a throttled track keeps its status and headers, so the client still knows the track's length, as it does from the API server; and a long-speech scenario makes each segment speak for a minute, for a track that plays long enough to lock the device.
- In the `tts-failure` scenario the [tracked speech provider](../../qa/test-worker/worker/speech-controls.ts) answers 400, which the provider does not mark as retryable, so it is permanent and the segment Workflow fails at once instead of waiting out its retry backoff. The Workflow's library tests cover retried 503s with the production retry count.

## Consequences

- WebKit runs the same journeys as Chromium, cookies included, at the cost of a certificate per run and an environment variable the worker processes must inherit.
- A change in Supabase's session, refresh-token or error behaviour must be mirrored in the fake provider by hand.
- A failing conversion in E2E fails fast and deterministically; retry behaviour is tested only at the library level.

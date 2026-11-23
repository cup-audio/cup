---
status: accepted
---

# Confirm an Apple-linked deletion with a fresh Apple sign-in and revoke its credential

App Store Review Guideline 5.1.1(v) requires that deleting an account created with Sign in with Apple revokes the app's Apple tokens through Apple's REST API. Revoking needs a token Apple issued to Cup: a refresh token or an access token. Supabase completes the Apple sign-in and hands Cup's client Apple's refresh token once, right after the redirect (`provider_refresh_token`), and does not keep it for Cup. The map [cup-audio/cup#465](https://github.com/cup-audio/cup/issues/465) decided where that token comes from at deletion in [#478](https://github.com/cup-audio/cup/issues/478) and how the confirmation asks for it in [#513](https://github.com/cup-audio/cup/issues/513); the spec [#519](https://github.com/cup-audio/cup/issues/519) collected the decisions, and [#522](https://github.com/cup-audio/cup/issues/522) built them for the web.

## Decision

- **Cup stores no Apple token.** Deleting an account with an Apple identity is confirmed only with a fresh Apple sign-in. Its deletion challenge accepts Apple alone (`acceptedMethods: ["apple"]`), also when the account has a Google identity too, and the confirmation request carries that sign-in's Apple credential: on the web, Supabase's `provider_refresh_token`.
- **The Worker revokes before it schedules.** It refuses an Apple-linked confirmation without an Apple credential, validates the refresh token at Apple with a `refresh_token` grant as the Services ID `audio.cup.app.web` to learn the Apple subject from the returned ID token, refuses a subject other than the account's Apple identity in Supabase, revokes the token, and only then schedules the deletion. A failed validation or revocation schedules nothing and answers a retryable error; a revocation followed by a failed scheduling is harmless, because the listener can sign in with Apple again. The Worker signs a short-lived ES256 client secret for each request with the Sign in with Apple key, so its secret never needs rotating.
- **The records say whether Apple was revoked.** The deletion job and its receipt carry `appleRevocation`: `unavailable` without an Apple identity, `revoked` after self-service deletion, and `not-revoked` for the operator-assisted path below. No token is recorded.
- **A listener who lost their Apple Account asks support.** The confirmation names `support@cup.audio`, and the operator schedules the deletion after an ownership check, recording `not-revoked`.

## Considered options

- **Store Apple's refresh token at sign-in (Apple's TN3194 flow).** Rejected: Cup would keep a long-lived credential for every Apple listener, encrypted and rotated, only to use it once at deletion, and it would still miss tokens from sign-ins whose handover the client never completed.
- **Revoke after scheduling, best effort, as Google is.** Rejected: Apple's rule makes the revocation part of the deletion, so a deletion that left Apple authorized would not meet it. Google revocation for a Google-only account stays best effort after scheduling.
- **Accept Google to confirm deletion of an account that also has Apple.** Rejected: a Google sign-in carries no Apple credential, so Apple would stay authorized.

## Consequences

- A listener who can no longer sign in with Apple cannot delete the account themselves; the operator-assisted path covers them without revocation; the operator CLI's lost-Apple-Account action implements it (cup-audio/cup#528).
- The deletion depends on Apple being reachable at the moment of confirmation; an outage shows "Apple couldn't confirm the deletion" and the listener retries with a new challenge and a new sign-in.
- Two assumptions stay unverified until production QA: that revoking the Services ID's token ends Cup's authorization across the app group, and that every native re-authorization returns a fresh code. If one fails, TN3194's store-at-sign-in flow reopens this decision.
- The Worker holds a third copy of the `.p8` key next to the operator's password manager and the GitHub environment of [ADR 0118](0118-rotate-supabases-apple-client-secret-from-a-scheduled-github-actions-workflow.md).

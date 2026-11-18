# Exchanging Apple's authorization code and revoking Apple tokens from a Cloudflare Worker

Research date: 2026-11-18, for [issue #469](https://github.com/cup-audio/cup/issues/469) of the [Sign in with Apple map](https://github.com/cup-audio/cup/issues/465). Repository observations are from `main` at `7cf2a405`, with `jose` `^6.2.17` in `@cup/api-server` and the Worker on compatibility date `2026-08-18` with `nodejs_compat`. Apple's developer documentation was read on the research date through its DocC JSON (`developer.apple.com/tutorials/data/documentation/<path>.json`), which carries the same text as the rendered pages. Supabase Auth source was read at commit `10ef1078` (2026-11-17). No Apple Developer setting was read or changed, no key was created, and no token was exchanged or revoked. Points marked _unverified_ need a check with a real Apple key and device.

## Question

What a Cloudflare Worker needs to exchange a Sign in with Apple authorization code for a refresh token and later revoke it: Apple's `/auth/token` and `/auth/revoke` REST endpoints, the ES256 client secret signed with the Sign in with Apple key (with `jose`), which client ID applies to codes from the native sheet versus the web flow, the code's lifetime and single use, refresh-token lifetime, what revocation does to the user's Apple ID settings, and how server-to-server notifications are registered, signed and verified.

## Answer

- **Two form-encoded POSTs.** `POST https://appleid.apple.com/auth/token` with `client_id`, `client_secret`, `code`, `grant_type=authorization_code` (and `redirect_uri` only if the authorization request had one) returns `access_token` (1 hour), `refresh_token` and `id_token`. `POST https://appleid.apple.com/auth/revoke` with `client_id`, `client_secret`, `token` and `token_type_hint` (`refresh_token` or `access_token`) returns `200` with no body, also when the token was already invalid ([Token validation][token], [Token revocation][revoke]). Both use `application/x-www-form-urlencoded`; `URLSearchParams` with `fetch` in a Worker does this.
- **Client secret.** A JWT signed ES256 with the Sign in with Apple `.p8` key: header `alg: ES256`, `kid` (10-character key ID); claims `iss` = Team ID, `iat`, `exp` at most 15,777,000 s (six months) ahead, `aud` = `https://appleid.apple.com`, `sub` = the same App ID or Services ID sent as `client_id` ([Creating a client secret][client-secret]). In a Worker, `jose`'s `importPKCS8(pem, "ES256")` and `new SignJWT(...).sign(key)` produce it through Web Crypto; `jose` lists Cloudflare Workers as supported and ES256 among its algorithms there ([jose README][jose-readme], [jose Workers support][jose-workers]). Because the Worker signs it per request, a short `exp` (minutes) is enough, and the six-month rotation that Supabase's own Apple secret needs does not apply to this one. The key never leaves the Worker's secrets.
- **Client ID per flow.** A code or token must be used with the client it was issued for; a mismatch is `invalid_grant` ([TN3107][tn3107]). The native `ASAuthorizationAppleIDProvider` sheet issues to the app's **App ID** (bundle ID `audio.cup.app`), the web flow to the **Services ID** ([Configuring your environment][environment]). Revocation's `client_id` "must match the value provided during the authorization request" ([Token revocation][revoke]). So the Worker needs two client secrets, one per `sub`, both signed with the same key, since a key belongs to a primary App ID and its group and a Services ID is associated with that primary app ([Create a Sign in with Apple private key][private-key]).
- **Code lifetime and single use.** The code is "single-use only and valid for five minutes" ([Token validation][token]). On iOS, Supabase's `signInWithIdToken` takes only the identity token, so the native code stays unused and the app can send it to the Worker. On the web, Supabase exchanges the code itself with the Services ID and, in the PKCE flow, hands Apple's refresh token to the client as `provider_refresh_token` ([Supabase Auth `external.go`][supabase-external], [Supabase Auth `apple.go`][supabase-apple]).
- **Refresh-token lifetime.** Apple documents no expiry: the refresh token stays usable "until it's invalidated", for example by an Apple Account password change or the user revoking access; Apple asks that it be validated at most once a day and may throttle more ([Verifying a user][verifying]). Validating a refresh token returns a new access and identity token but no new refresh token ([TokenResponse][token-response]).
- **What revocation does.** `/auth/revoke` "invalidate[s] the tokens and associated user authorizations" and is "the only way to programmatically invalidate user tokens [...] without user interaction" ([Token revocation][revoke], [TN3194][tn3194]). TN3194 says that without revocation the credential state stays `authorized`, the next sign-in skips the name and email consent, and the sheet may say "Continue with Apple"; revoking resets that, and Apple may email the user that the app revoked their Sign in with Apple access ([TN3194][tn3194], [Apple support: stop using Sign in with Apple][support-stop]). That the app then disappears from Settings › Sign in with Apple is the documented consequence of revoked consent, but is _unverified_ for an API revocation.
- **Server-to-server notifications.** One absolute HTTPS URL (TLS 1.2+) per Sign in with Apple app group and key, set on the primary App ID in Certificates, Identifiers & Profiles ([Enabling server-to-server notifications][s2s-help], [Configuring your environment][environment]). Apple POSTs JSON `{"payload": "<JWT>"}`, a JWS signed by Apple and verified against `https://appleid.apple.com/auth/keys` by `kid`, with `iss` `https://appleid.apple.com`, `aud` the client ID and an `events` claim of type `email-disabled`, `email-enabled`, `consent-revoked` or `account-deleted` with the user's `sub` ([Processing changes for Sign in with Apple accounts][s2s], [Fetch Apple's public key][keys]). `jose`'s `createRemoteJWKSet` plus `jwtVerify` does this in a Worker, as [`account-auth.ts`](../../../libs/api-server/src/http/account-auth.ts) already does for Supabase. Supabase Auth itself does not support the notification endpoint, so the URL would point at Cup's Worker ([Supabase Apple guide][supabase-guide]).
- **Implication for Cup.** Apple's recommended flow stores the refresh token at account creation ([TN3194][tn3194]). Cup's deletion already requires a fresh sign-in with the account's provider ([account deletion](../../architecture/account-deletion.md)), which yields a new code (native) or `provider_refresh_token` (web) at deletion time. The Worker can exchange and revoke it right away, as it revokes Google's `provider_token` today, and hold no Apple credential between sign-ins. Whether revoking a token from one client of the group (say, the Services ID) ends consent for the other (the App ID) is _unverified_ and decides whether that works across platforms.

## 1. Exchanging the authorization code

Apple's [Token validation][token] page defines `POST https://appleid.apple.com/auth/token` with a form body:

| Parameter       | Required                         | Value                                                                                                   |
| --------------- | -------------------------------- | ------------------------------------------------------------------------------------------------------- |
| `client_id`     | yes                              | App ID or Services ID, "must not include your Team ID"                                                  |
| `client_secret` | yes                              | the client-secret JWT (section 2)                                                                       |
| `code`          | for code exchange                | the authorization code; "single-use only and valid for five minutes"                                    |
| `grant_type`    | yes                              | `authorization_code`, or `refresh_token` to validate a stored refresh token                             |
| `refresh_token` | for refresh validation           | the stored refresh token                                                                                |
| `redirect_uri`  | only if the authorization had it | HTTPS with a domain, no IP, no `localhost`, no fragment; omitted for the native sheet, which sends none |

A successful code exchange returns `{ access_token, token_type: "Bearer", expires_in: 3600, refresh_token, id_token }`. A refresh-token validation returns the same without `refresh_token` ([Token validation][token], [TokenResponse][token-response]). Errors are `400` with `{ "error": ... }`, one of `invalid_request`, `invalid_client`, `invalid_grant`, `unauthorized_client`, `unsupported_grant_type`, `invalid_scope` ([ErrorResponse][error-response]).

[TN3107][tn3107] lists the usual causes. `invalid_client`: form data not percent-encoded, missing header or claim in the client secret, a `sub` not identical to the registered identifier, an expired secret, or a signature "in an unsupported byte format" (the library must not produce ASN.1 DER signatures; JWS uses raw `r||s`, which `jose` emits). `invalid_grant`: the `client_id` doesn't match the client the code or token was issued for, or the code is expired or already consumed. `invalid_request` also covers a user who has revoked authorization.

The `id_token` in the response is Apple's identity JWT. Its `sub` is the user's team-scoped stable identifier, the same across the team's apps and different across teams; `aud` is the `client_id`; `email`, `email_verified` and `is_private_email` may be strings or booleans ([id_token][id-token]). The Worker should verify it with `jose` against Apple's keys (`iss` `https://appleid.apple.com`, `aud` the client ID used) and compare its `sub` with the Apple identity linked to the Supabase user, mirroring how [`google-token-revocation.ts`](../../../libs/api-server/src/adapters/google-token-revocation.ts) checks Google's `userinfo` subject against the Supabase identity before revoking. [Verifying a user][verifying] lists the identity-token checks: signature, `nonce`, `iss`, `aud`, `exp`.

## 2. The client secret with `jose` in a Worker

[Creating a client secret][client-secret] (linked from the Sign in with Apple REST pages, now hosted under Account and Organizational Data Sharing) specifies:

- Header: `alg` `ES256`, `kid` the 10-character key identifier.
- Claims: `iss` the 10-character Team ID; `iat`; `exp` no more than 15,777,000 seconds (six months) after Apple's clock; `aud` `https://appleid.apple.com`; `sub` the App ID or Services ID used as `client_id`, case-sensitive.
- Signature: ECDSA P-256 with SHA-256.

The key is created in Certificates, Identifiers & Profiles with Sign in with Apple enabled and associated with a primary App ID; each primary App ID can have at most two keys, which allows rotation (create the new key, switch, then revoke the old one) ([Create a Sign in with Apple private key][private-key], [Configuring your environment][environment]). The downloaded `.p8` file is a PEM PKCS #8 EC key, which `jose`'s `importPKCS8` takes ([importPKCS8][jose-pkcs8]).

A sketch for the Worker, with the key and identifiers as Worker secrets:

```ts
import { SignJWT, importPKCS8 } from "jose";

async function appleClientSecret(env: Env, clientId: string) {
  const key = await importPKCS8(env.APPLE_SIGN_IN_PRIVATE_KEY, "ES256");
  return new SignJWT({})
    .setProtectedHeader({ alg: "ES256", kid: env.APPLE_SIGN_IN_KEY_ID })
    .setIssuer(env.APPLE_TEAM_ID)
    .setSubject(clientId)
    .setAudience("https://appleid.apple.com")
    .setIssuedAt()
    .setExpirationTime("5m")
    .sign(key);
}
```

`jose` "is designed to work across various Web-interoperable runtimes including [...] Cloudflare Workers" and supports `ES256` on Workers ([jose README][jose-readme], [jose Workers support][jose-workers]); Cloudflare's Web Crypto supports ECDSA for `sign`, `verify` and `importKey` ([Workers Web Crypto][cf-webcrypto]). Worker secrets are set with `wrangler secret put` or uploaded with `--secrets-file` ([Workers secrets][cf-secrets]); Cloudflare's page does not say whether multi-line values such as a PEM survive, so storing the PEM base64-encoded or with escaped newlines is the safe choice (_unverified_).

The repository already depends on `jose` 6 in `@cup/api-server` for Supabase JWT verification, so no new dependency is needed.

## 3. Which client ID: native sheet versus web

[Configuring your environment][environment] says a Services ID is the client identifier "when authenticating or validating users with Sign in with Apple JS and Sign in with Apple REST API" on the web or other platforms, while native apps use their App ID; the identity token's `aud` is that `client_id` ([id_token][id-token]). Apple rejects a code or refresh token used with any other client ([TN3107][tn3107]), and revocation's `client_id` must match the one used at authorization ([Token revocation][revoke]).

| Where the credential came from                                          | `client_id` / client-secret `sub` | What the Worker receives                                                   |
| ----------------------------------------------------------------------- | --------------------------------- | -------------------------------------------------------------------------- |
| iOS native sheet (`ASAuthorizationAppleIDCredential.authorizationCode`) | App ID, e.g. `audio.cup.app`      | the code, from the app; exchange it within five minutes, no `redirect_uri` |
| Web, Supabase OAuth with PKCE                                           | Services ID                       | Apple's refresh token as `provider_refresh_token`, from the client         |

The native credential's `authorizationCode` is "a short-lived token that the app uses [...] as proof that it has authorization to interact with the server" ([authorizationCode][native-code]). Supabase's native `signInWithIdToken` uses only the identity token and accepts any configured client ID as audience; for the web flow Supabase sends `ClientID[0]`, which the guide says must be the Services ID ([Supabase Apple guide][supabase-guide], [Supabase Auth `apple.go`][supabase-apple]). Supabase therefore never consumes the native code.

In the web PKCE flow, Supabase Auth's callback stores Apple's access and refresh tokens in the flow state and returns them at code exchange; supabase-js exposes them as `session.provider_token` and `session.provider_refresh_token` ([Supabase Auth `external.go`][supabase-external]). Cup's web client already forwards `session.provider_token` to the deletion endpoint for Google ([`account-confirmation.ts`](../../../apps/web-app/src/data-fetching/account-confirmation.ts)); for Apple it would forward `provider_refresh_token` instead, which outlives the one-hour access token. iOS's current OAuth browser sheet ([ADR 0019](../../adr/0019-sign-in-on-ios-through-supabase-oauth-in-a-system-browser-sheet.md)) would receive the same, but the map settles native for Apple on iOS. The Worker must refuse codes or tokens whose identity's `sub` doesn't match the signed-in Apple identity.

## 4. Revocation

[Token revocation][revoke] defines `POST https://appleid.apple.com/auth/revoke` with `client_id`, `client_secret`, `token` (refresh or access token) and optional `token_type_hint`. It returns `200` without a body "after the server invalidates the `token` value, or if the `token` value was previously invalidated", so retries are idempotent. An identity token or a Supabase token cannot be revoked; without a refresh or access token, Apple says to obtain one by validating an authorization code. TN3107 lists the same `invalid_request`, `invalid_client` and `invalid_grant` errors for `/auth/revoke` ([TN3107][tn3107]).

[TN3194][tn3194] (first published 2025-10-03) frames the account-deletion duty:

- `/auth/revoke` is the only programmatic way to invalidate a user's tokens.
- Store the identity, refresh and access tokens from the code exchange at account creation, and validate the refresh token up to once a day.
- Without a refresh token, access token or authorization code, the app must still delete the account, direct the user to revoke access manually, and respond to the revocation notification.
- Without revocation, the credential state stays `authorized`, the next sign-in shows no name and email consent, and the button may read "Continue with Apple".

Apple's support page tells users they can stop using Sign in with Apple in Settings › your name › Sign in with Apple (iOS), System Settings (Mac) or account.apple.com, and that when an app deletes the account, "Apple may email" them that the app revoked access; a new account later shares name and email again ([Apple support: stop using Sign in with Apple][support-stop]). The developer docs do not state outright that an API revocation removes the app from that list; it is the expected effect of invalidating "the associated user authorizations" (_unverified_).

Two open questions decide Cup's design and need a test with a real key:

1. Whether revoking a token issued to the Services ID also ends consent for the native App ID in the same group, and vice versa. Consent is per app group ([Configuring your environment][environment]), which suggests yes (_unverified_).
2. Whether a fresh native sign-in at deletion time, for an Apple ID that has already authorized Cup, returns a new authorization code every time. Apple says the server returns a "single-use authorization grant code" after successful authentication, not only the first ([Authenticating users with Sign in with Apple][authenticating]) (_unverified_ on a device).

If both hold, Cup can revoke at deletion from the fresh sign-in, exactly like its Google path, and skip storing Apple refresh tokens. If not, the Worker must exchange the native code at sign-in, keep the refresh token per identity (encrypted, for example in the registry Durable Object), and revoke it at deletion; the account deletion research already listed that custody as a prerequisite ([account deletion research](../social-signup/account-deletion-research.md#practical-prerequisites-and-unresolved-details)). TN3194's recommendation to store tokens at creation is a recommendation, not a requirement; the requirement is that deletion revokes the user's tokens.

## 5. Server-to-server notifications

**Registration.** In Certificates, Identifiers & Profiles, select the primary App ID, open the Sign in with Apple configuration, and enter one absolute URL (scheme, host, path) per app group and key; TLS 1.2 or later is required ([Enabling server-to-server notifications][s2s-help], [Configuring your environment][environment]). The page doesn't describe delivery retries.

**Events.** `email-disabled` and `email-enabled` (Hide My Email forwarding, with `email` and `is_private_email`), `consent-revoked` (the user stopped using Sign in with Apple for the app and "their credentials become invalid"), and `account-deleted` (the user asked Apple to delete their Apple Account; Apple invalidates all tokens and stops relay forwarding, and native apps get no `credentialRevokedNotification`) ([Processing changes for Sign in with Apple accounts][s2s]).

**Format and verification.** Apple POSTs `{"payload": "<JWT>"}`. The JWT is signed by Apple; verify it with the key from `GET https://appleid.apple.com/auth/keys` whose `kid` matches the header, then act on `events.type` ([Processing changes][s2s], [Fetch Apple's public key][keys]). Apple's examples show claims `iss` `https://appleid.apple.com`, `aud` the client ID, `iat`, `jti` and `events` `{ type, sub, event_time, ... }`. In a Worker:

```ts
import { createRemoteJWKSet, jwtVerify } from "jose";

const appleKeys = createRemoteJWKSet(new URL("https://appleid.apple.com/auth/keys"));

const { payload } = await jwtVerify(body.payload, appleKeys, {
  issuer: "https://appleid.apple.com",
  audience: ["audio.cup.app", APPLE_SERVICES_ID],
});
```

Apple's examples show `events` as a JSON object; which `aud` a group-level notification carries, and whether `events` may arrive as a JSON-encoded string, are _unverified_, so the handler should accept both shapes and both client IDs. `jti` allows deduplicating repeated deliveries. Supabase Auth "does not support Server-to-Server notification endpoints" ([Supabase Apple guide][supabase-guide]), so the endpoint would be a Worker route. Whether Cup handles these events at all is a separate ticket on the map.

## Sources

All observed 2026-11-18.

[token]: https://developer.apple.com/documentation/signinwithapplerestapi/generate-and-validate-tokens
[revoke]: https://developer.apple.com/documentation/signinwithapplerestapi/revoke-tokens
[token-response]: https://developer.apple.com/documentation/signinwithapplerestapi/tokenresponse
[error-response]: https://developer.apple.com/documentation/signinwithapplerestapi/errorresponse
[keys]: https://developer.apple.com/documentation/signinwithapplerestapi/fetch-apple's-public-key-for-verifying-token-signature
[client-secret]: https://developer.apple.com/documentation/accountorganizationaldatasharing/creating-a-client-secret
[id-token]: https://developer.apple.com/documentation/signinwithapplejs/authorizationi/id_token
[verifying]: https://developer.apple.com/documentation/signinwithapple/verifying-a-user
[authenticating]: https://developer.apple.com/documentation/signinwithapple/authenticating-users-with-sign-in-with-apple
[environment]: https://developer.apple.com/documentation/signinwithapple/configuring-your-environment-for-sign-in-with-apple
[s2s]: https://developer.apple.com/documentation/signinwithapple/processing-changes-for-sign-in-with-apple-accounts
[s2s-help]: https://developer.apple.com/help/account/configure-app-capabilities/enabling-server-to-server-notifications
[private-key]: https://developer.apple.com/help/account/capabilities/create-a-sign-in-with-apple-private-key
[native-code]: https://developer.apple.com/documentation/authenticationservices/asauthorizationappleidcredential/authorizationcode
[tn3107]: https://developer.apple.com/documentation/technotes/tn3107-resolving-sign-in-with-apple-response-errors
[tn3194]: https://developer.apple.com/documentation/technotes/tn3194-handling-account-deletions-and-revoking-tokens-for-sign-in-with-apple
[support-stop]: https://support.apple.com/en-us/102571
[jose-readme]: https://github.com/panva/jose#supported-runtimes
[jose-workers]: https://github.com/panva/jose/issues/265
[jose-pkcs8]: https://github.com/panva/jose/blob/main/docs/key/import/functions/importPKCS8.md
[cf-webcrypto]: https://developers.cloudflare.com/workers/runtime-apis/web-crypto/
[cf-secrets]: https://developers.cloudflare.com/workers/configuration/secrets/
[supabase-guide]: https://supabase.com/docs/guides/auth/social-login/auth-apple
[supabase-apple]: https://github.com/supabase/auth/blob/10ef10789d1ee4fb422b448047e67e3e264c0482/internal/api/provider/apple.go
[supabase-external]: https://github.com/supabase/auth/blob/10ef10789d1ee4fb422b448047e67e3e264c0482/internal/api/external.go#L200-L292

- Apple: [Token validation][token], [Token revocation][revoke], [TokenResponse][token-response], [ErrorResponse][error-response], [Fetch Apple's public key][keys], [Creating a client secret][client-secret], [id_token][id-token], [Verifying a user][verifying], [Authenticating users][authenticating], [Configuring your environment][environment], [Processing changes for Sign in with Apple accounts][s2s], [Enabling server-to-server notifications][s2s-help], [Create a Sign in with Apple private key][private-key], [authorizationCode][native-code], [TN3107][tn3107], [TN3194][tn3194], [Stop using Sign in with Apple][support-stop].
- `jose`: [README, supported runtimes][jose-readme], [Cloudflare Workers support][jose-workers], [importPKCS8][jose-pkcs8].
- Cloudflare: [Web Crypto][cf-webcrypto], [Secrets][cf-secrets].
- Supabase: [Apple guide][supabase-guide], [Auth `apple.go` at `10ef1078`][supabase-apple], [Auth `external.go` at `10ef1078`][supabase-external].
- Repository: [`account-auth.ts`](../../../libs/api-server/src/http/account-auth.ts), [`google-token-revocation.ts`](../../../libs/api-server/src/adapters/google-token-revocation.ts), [`account-confirmation.ts`](../../../apps/web-app/src/data-fetching/account-confirmation.ts), [account deletion](../../architecture/account-deletion.md), [authentication](../../architecture/authentication.md), [account deletion research](../social-signup/account-deletion-research.md).

# Supabase Auth's Apple provider across native iOS and the web

Research date: 2026-11-18, for [issue #468](https://github.com/cup-audio/cup/issues/468) of the [Sign in with Apple map](https://github.com/cup-audio/cup/issues/465). Supabase Auth (GoTrue) source was read at [`supabase/auth@10ef107`][auth] (2026-11-17), the Supabase Terraform provider at [`supabase/terraform-provider-supabase@a9e8b07`][tfp] (2026-11-17), and the Management API's OpenAPI document at `https://api.supabase.com/api/v1-json` on the research date. Supabase and Apple documentation pages were read on the research date. Hosted Supabase runs a build of this source whose exact version was not checked; nothing was tried against a real Apple identity, so every behaviour below is from source and documentation, not a probe. Repository observations are from `main` at `7cf2a405`.

## Question

How does Supabase Auth's Apple provider work for one project used by a native iOS app (`signInWithIdToken`) and the web (OAuth with PKCE): the client ID list (bundle ID plus Services ID), the client secret JWT and its six-month expiry, the Supabase Terraform provider's fields for Apple, automatic identity linking by verified email (and how a Hide My Email address behaves), what lands in the JWT's `app_metadata.provider` and `amr`, the name arriving only on first sign-in, whether Supabase exposes or stores Apple's refresh token (`provider_refresh_token`) on either flow, and whether Supabase revokes Apple tokens when a user is deleted.

## Answer

One Supabase project serves both flows with one Apple provider configuration: the client ID list holds the Services ID **first** (web OAuth uses only the first entry) and the iOS bundle ID after it (the native ID-token grant accepts any entry as the token's audience). The client secret is a JWT Cup signs with its Sign in with Apple key, valid at most six months, and only the web flow uses it; Terraform sets it as `external_apple_secret` and cannot see it drift. Automatic linking joins an Apple identity to an existing user with the same email, because Supabase treats every Apple email as verified; a Hide My Email address practically never matches. `app_metadata.provider` names the user's **oldest** identity, not the one that just signed in, and `amr` says `oauth` for both flows without naming a provider. The name comes only from the web callback's first response; native sign-in never carries it. Supabase hands Apple's refresh token to the client once on the web (`provider_refresh_token` in the code exchange response) and keeps no copy; the native grant never sees an Apple refresh token at all. Deleting a Supabase user revokes nothing at Apple.

| Topic                     | Native iOS (`signInWithIdToken`, provider `apple`)                                   | Web (OAuth with PKCE)                                                                          |
| ------------------------- | ------------------------------------------------------------------------------------ | ---------------------------------------------------------------------------------------------- |
| Client ID that matters    | The bundle ID, anywhere in the list, as the ID token's `aud`                         | The Services ID, which must be the list's first entry                                          |
| Client secret             | Not used                                                                             | Used for Apple's code exchange; expires after at most six months                               |
| Nonce                     | Required unless neither side sends one; Supabase checks `sha256(raw) == token.nonce` | Not applicable (Supabase's own `state` and PKCE)                                               |
| Name                      | Never; the app must save it with `updateUser`                                        | Saved into `user_metadata.name` and `full_name` when Apple posts `user` on first authorization |
| Apple refresh token       | Never seen by Supabase                                                               | Returned once as `provider_refresh_token` from the code exchange; not stored after it          |
| JWT `amr`                 | `[{ "method": "oauth", "timestamp": … }]`                                            | `[{ "method": "oauth", "timestamp": … }]`                                                      |
| JWT `app_metadata`        | `provider`: the oldest identity's provider; `providers`: all, oldest first           | Same                                                                                           |
| Revocation on user delete | None                                                                                 | None                                                                                           |

## Client IDs: Services ID first, bundle ID after

GoTrue keeps the Apple provider's client IDs as a list (`ClientID []string`, [`configuration.go`][conf-oauth]). The two flows read it differently:

- **Web OAuth** builds its OAuth client from `ext.ClientID[0]` only ([`apple.go#L107`][apple-clientid]). Apple checks that `client_id` against the Services ID whose return URL is Supabase's callback, so the Services ID must come first. Supabase's guide says the same: "list this Services ID as the **first** entry in the _Client IDs_ field", and if a native App ID comes first, "native sign-in keeps working but web sign-in is rejected by Apple" ([Supabase Apple guide][sb-apple]).
- **The ID-token grant** accepts a token whose `aud` matches _any_ listed client ID, plus `GOTRUE_EXTERNAL_IOS_BUNDLE_ID` when set ([`token_oidc.go#L63-L67`][oidc-aud]). A token from the native sheet has the bundle ID as `aud`, so the bundle ID must be in the list. The separate bundle-ID setting has no Management API field (below), so on hosted Supabase the bundle ID goes into the list.

Apple's issuer is checked by detection rather than by the OIDC library: GoTrue reads `iss` from the token, accepts `https://appleid.apple.com` or `https://account.apple.com`, and skips the library's own client-ID and issuer checks before running its own audience check ([`token_oidc.go#L45-L60`][oidc-issuer], [`token_oidc.go#L247-L252`][oidc-skip]).

## Nonce on the native flow

The Management API has no `external_apple_skip_nonce_check` field (it has one only for Google), so Apple's nonce check stays on. GoTrue rejects the grant if exactly one of the request and the token has a nonce, and otherwise requires the token's `nonce` to equal the hex SHA-256 of the raw nonce the client sends ([`token_oidc.go#L294-L306`][oidc-nonce]). The native app therefore puts the SHA-256 of a random nonce into `ASAuthorizationAppleIDRequest.nonce` and sends the raw nonce to `signInWithIdToken`, as Cup's Android adapter already does for Google. A request with no nonce on either side passes; Cup should not rely on that.

## The client secret and its six-month expiry

Apple's client secret is an ES256 JWT signed with a Sign in with Apple private key: header `kid` is the key ID; claims `iss` (Team ID), `iat`, `exp`, `aud` `https://appleid.apple.com`, and `sub`, which is "the same App ID or Services ID that you use as the client_id" (case-sensitive). "It’s an error to request an expiration time more than 15777000 seconds (six months) in the future" ([Apple: Creating a client secret][apple-secret]). Because `sub` must equal the `client_id`, the secret Supabase holds (for the Services ID) cannot authenticate a request made with the bundle ID as `client_id`.

GoTrue sends the secret only in the web code exchange ([`apple.go#L119-L127`][apple-exchange]); the ID-token grant never calls Apple. Supabase's guide: "Apple requires you to generate a new secret key every 6 months using the signing key (`.p8` file)", calls it "a critical maintenance task that will cause authentication failures if missed", and notes "Native-only implementations don't require secret key rotation" ([Supabase Apple guide][sb-apple]). With web sign-in enabled, an expired secret breaks web Apple sign-in and nothing else.

## Terraform and Management API fields

The Terraform provider's `supabase_settings.auth` is serialised JSON passed to the Management API's `PATCH /v1/projects/{ref}/config/auth` ([settings docs][tfp-settings]), as [`terraform/production/supabase.tf`](../../../terraform/production/supabase.tf) already does for Google. The API's `UpdateAuthConfigBody` has these Apple fields, all nullable ([Management API spec][mgmt-api]):

| Field                                  | Type    | Use                                                |
| -------------------------------------- | ------- | -------------------------------------------------- |
| `external_apple_enabled`               | boolean | Enables the provider for both flows                |
| `external_apple_client_id`             | string  | The Services ID (first entry)                      |
| `external_apple_additional_client_ids` | string  | Comma-separated further IDs, such as the bundle ID |
| `external_apple_secret`                | string  | The client secret JWT                              |
| `external_apple_email_optional`        | boolean | Lets a sign-in without an email succeed            |

There is no Apple nonce-skip field, no iOS bundle ID field and no account-linking-domain field; the only linking setting is `security_manual_linking_enabled`. The provider handles two Apple quirks itself ([`settings_resource.go#L878-L889`][tfp-preserve], [`settings_resource_test.go#L811-L905`][tfp-test]): the API can return the additional IDs folded into `external_apple_client_id` (the test's mock returns `services,ios,macos`, Services ID first), so the provider keeps the configured split in state to avoid drift; and the API returns `external_apple_secret` as a hash, so the provider keeps the value from prior state, and "out-of-band changes will not appear in `terraform plan`" ([settings docs][tfp-settings]). A rotated secret therefore reaches Supabase only when Terraform applies a new value, and nothing in the plan reveals an expired one.

## Automatic linking and Hide My Email

GoTrue builds Apple's user data from the ID token on both flows (the web flow parses the `id_token` from Apple's code exchange, [`apple.go#L148-L167`][apple-userdata]). It marks the token's email `Verified: true` and `Primary: true` unconditionally, and copies `is_private_email`, `auth_time` and `transfer_sub` into the identity's `custom_claims` ([`oidc.go#L177-L214`][oidc-apple]).

`DetermineAccountLinking` then decides ([`linking.go`][linking]):

1. An identity with the same provider and subject exists: sign into its user (`AccountExists`).
2. Otherwise, with a verified email, if a user or identity in the same linking domain has that email, add the Apple identity to that user (`LinkAccount`). All social providers share the `default` domain unless `GOTRUE_EXPERIMENTAL_PROVIDER_LINKING_DOMAINS` separates them, a setting with no Management API field.
3. Otherwise create a new user.

So an Apple sign-in whose email is the same address as an existing Google user's joins that Google user. Supabase's guide states the rule, "Supabase Auth automatically links identities with the same email address to a single user", and limits it to verified emails to prevent pre-account takeover ([Supabase identity linking][sb-linking]).

A Hide My Email address is still a verified email to Supabase, so it links only to a user that already has the same relay address. Apple's relay addresses end in `@private.icloud.com`, `@privaterelay.appleid.com` or `@icloud.com`, and are "the same for a user across all apps written by a single development team, and different for the same user across apps written by different development teams" ([Apple: private email relay][apple-relay]). A Google account never has such an address, so a person who hides their email gets a separate Supabase user from their Google one. Because the address is team-scoped, a later change of Apple developer team changes it, along with the Apple subject. Mail to it requires Cup's sending domain to be registered with Apple, with SPF, and each relay address takes at most 100 emails a day ([Apple: private email relay][apple-relay]).

## The JWT: `app_metadata.provider` and `amr`

Every sign-in, linking or not, recomputes `app_metadata` with `providers` (distinct providers of the user's identities, ordered by identity `created_at` ascending) and `provider = providers[0]` ([`user.go#L262-L274`][user-providers], [`identity.go#L109-L126`][identity-order]). For a user created by Apple, `provider` is `apple`. For a Google user whose Apple identity was linked later, `provider` stays `google` and `providers` is `["google","apple"]`, including in a session that Apple started. `app_metadata.provider` thus answers "which provider created this user", not "which provider signed in now".

Both flows issue the session with `models.OAuth` ([`token_oidc.go#L346`][oidc-session], [`external.go#L248-L255`][external-implicit]; the PKCE exchange reuses the method stored in the flow state, [`token.go#L328-L337`][token-pkce]), whose string is `oauth` ([`factor.go#L75-L78`][factor]). The JWT's `amr` entries are built from the session's claims as `{ method, timestamp }`, with `provider` filled in only for SAML SSO ([`sessions.go#L390-L407`][amr]). An Apple sign-in therefore yields `amr: [{"method":"oauth","timestamp":…}]` on either flow, the same as Google; no `id_token` method exists. Nothing in the access token tells Google and Apple sessions apart.

For Cup this means the Worker's check `provider !== "google"` in [`account-auth.ts`](../../../libs/api-server/src/http/account-auth.ts) admits a linked Google-first user signing in through Apple and rejects an Apple-first user, and the freshness check (methods `oauth` or `id_token`) would count any provider's sign-in as fresh. Which provider started a session has to come from somewhere other than these claims.

## The name arrives only once, and only on the web

Apple: "Although Apple provides the user’s email address in the identity token on all subsequent API responses, it doesn’t include other information about the user, such as their name", and the name is shared again only "if the user stops using Sign in with Apple and later reconnects to your app" ([Apple: authenticating users][apple-auth]). On native, `ASAuthorizationAppleIDCredential.fullName` "is not included in the user’s identity token" ([Apple: `fullName`][apple-fullname]).

- **Web.** GoTrue asks for scopes `email name` with `response_mode=form_post` ([`apple.go#L91-L114`][apple-clientid], [`apple.go#L133-L144`][apple-authurl]); on the callback it parses Apple's `user` form field when present and sets `name` and `full_name` ([`external_oauth.go#L129-L138`][external-user], [`apple.go#L169-L179`][apple-parseuser]).
- **Native.** The ID-token grant has no name input. Supabase's guide says the name "must be captured from Apple's native authentication response and manually saved using the `updateUser` method" ([Supabase Apple guide][sb-apple]).

On later sign-ins GoTrue replaces the identity's `identity_data` with the new token's data, which has no name, but merges into `user_metadata` key by key, skipping absent keys ([`external.go#L384-L397`][external-exists], [`user.go#L230-L243`][user-meta]). A name saved once stays in `user_metadata` and drops out of `identities[].identity_data` after the next sign-in.

## Apple's refresh token

Apple returns a refresh token only from validating an authorization code; the code "is single-use only and valid for five minutes", and the refresh token, which Apple says to "store … securely on your server", is what its revoke endpoint takes, along with the same `client_id` that obtained it and a client secret ([Apple: generate and validate tokens][apple-token], [Apple: TokenResponse][apple-tokenresponse], [Apple: revoke tokens][apple-revoke]).

- **Web with PKCE.** GoTrue exchanges Apple's code and puts Apple's access and refresh tokens on the flow state row ([`external.go#L232-L247`][external-flowstate]). When the client exchanges Supabase's auth code, the response carries them as `provider_token` and `provider_refresh_token`, and the flow state row is deleted in the same transaction ([`token.go#L338-L352`][token-pkce]; field in [`service.go#L119`][token-field]). An auth code never exchanged leaves its row until cleanup deletes flow states older than 24 hours ([`cleanup.go#L60`][cleanup]). Supabase keeps no copy on the user or identity, and later refreshes of the Supabase session return no provider tokens. This refresh token belongs to the Services ID, so revoking it needs a client secret whose `sub` is the Services ID. In the implicit flow GoTrue would put it in the redirect URL instead ([`external.go#L286-L295`][external-implicit-url]).
- **Native.** Supabase receives only the identity token (and optionally an access token for `at_hash`) and never calls Apple ([`token_oidc.go#L21-L30`][oidc-params]), so it never has an Apple refresh token. The native credential's `authorizationCode` is untouched by Supabase; to get a refresh token, the app has to send that code to Cup's server within five minutes, and the server exchanges it at `https://appleid.apple.com/auth/token` with `client_id` set to the bundle ID and a client secret whose `sub` is the bundle ID. Apple's verification guide describes exactly this server step ([Apple: verifying a user][apple-verify]). Supabase's guide demonstrates neither capture nor revocation ([Supabase Apple guide][sb-apple]).

## User deletion revokes nothing at Apple

GoTrue's `adminUserDelete` deletes or soft-deletes the user, its identities and sessions in a transaction with an audit entry, and calls no provider ([`admin.go#L595-L660`][admin-delete]); the provider package has no revoke call for any provider. Revoking Apple's grant on account deletion is Cup's job, using a refresh or access token Cup kept and the matching `client_id`, as [account deletion](../../architecture/account-deletion.md) already does for Google with a client-supplied provider token. This agrees with the earlier [account deletion research](../social-signup/account-deletion-research.md).

## Open points

- The hosted Supabase build was not compared with the source commit; a probe with a real Apple identity on both flows would confirm `aud` handling, the `amr` and `app_metadata` shape after linking, and `provider_refresh_token` in `exchangeCodeForSession`.
- What GoTrue does with an Apple token that has no `email` claim (a native request without the email scope) was not traced; Cup's native request should ask for `email` and `fullName`.
- Whether Supabase users linked by email across Google and Apple are acceptable is the map's decision; the only switch on hosted Supabase found here is manual linking, not a way to turn automatic linking off.

## Sources

- Supabase: [Login with Apple][sb-apple], [Identity linking][sb-linking], [Management API OpenAPI document][mgmt-api]. Supabase Auth source at [`10ef107`][auth]. Terraform provider at [`a9e8b07`][tfp]: [`supabase_settings` docs][tfp-settings], [`settings_resource.go`][tfp-preserve], [`settings_resource_test.go`][tfp-test].
- Apple: [Creating a client secret][apple-secret], [Generate and validate tokens][apple-token], [TokenResponse][apple-tokenresponse], [Revoke tokens][apple-revoke], [Authenticating users with Sign in with Apple][apple-auth], [Verifying a user][apple-verify], [`fullName`][apple-fullname], [Communicating using the private email relay service][apple-relay].
- Cup: [`supabase.tf`](../../../terraform/production/supabase.tf), [`account-auth.ts`](../../../libs/api-server/src/http/account-auth.ts), [authentication](../../architecture/authentication.md), [account deletion](../../architecture/account-deletion.md), [social sign-up research](../social-signup/deferred-apple-ios.md).

[auth]: https://github.com/supabase/auth/tree/10ef10789d1ee4fb422b448047e67e3e264c0482
[tfp]: https://github.com/supabase/terraform-provider-supabase/tree/a9e8b074d4bda3bd3d8de2805b63bb3d4b1d56cd
[conf-oauth]: https://github.com/supabase/auth/blob/10ef10789d1ee4fb422b448047e67e3e264c0482/internal/conf/configuration.go#L65-L77
[apple-clientid]: https://github.com/supabase/auth/blob/10ef10789d1ee4fb422b448047e67e3e264c0482/internal/api/provider/apple.go#L91-L114
[apple-exchange]: https://github.com/supabase/auth/blob/10ef10789d1ee4fb422b448047e67e3e264c0482/internal/api/provider/apple.go#L119-L127
[apple-authurl]: https://github.com/supabase/auth/blob/10ef10789d1ee4fb422b448047e67e3e264c0482/internal/api/provider/apple.go#L133-L144
[apple-userdata]: https://github.com/supabase/auth/blob/10ef10789d1ee4fb422b448047e67e3e264c0482/internal/api/provider/apple.go#L148-L167
[apple-parseuser]: https://github.com/supabase/auth/blob/10ef10789d1ee4fb422b448047e67e3e264c0482/internal/api/provider/apple.go#L169-L179
[oidc-params]: https://github.com/supabase/auth/blob/10ef10789d1ee4fb422b448047e67e3e264c0482/internal/api/token_oidc.go#L21-L30
[oidc-issuer]: https://github.com/supabase/auth/blob/10ef10789d1ee4fb422b448047e67e3e264c0482/internal/api/token_oidc.go#L45-L60
[oidc-aud]: https://github.com/supabase/auth/blob/10ef10789d1ee4fb422b448047e67e3e264c0482/internal/api/token_oidc.go#L63-L67
[oidc-skip]: https://github.com/supabase/auth/blob/10ef10789d1ee4fb422b448047e67e3e264c0482/internal/api/token_oidc.go#L247-L252
[oidc-nonce]: https://github.com/supabase/auth/blob/10ef10789d1ee4fb422b448047e67e3e264c0482/internal/api/token_oidc.go#L294-L306
[oidc-session]: https://github.com/supabase/auth/blob/10ef10789d1ee4fb422b448047e67e3e264c0482/internal/api/token_oidc.go#L346
[oidc-apple]: https://github.com/supabase/auth/blob/10ef10789d1ee4fb422b448047e67e3e264c0482/internal/api/provider/oidc.go#L166-L214
[external-user]: https://github.com/supabase/auth/blob/10ef10789d1ee4fb422b448047e67e3e264c0482/internal/api/external_oauth.go#L129-L138
[external-flowstate]: https://github.com/supabase/auth/blob/10ef10789d1ee4fb422b448047e67e3e264c0482/internal/api/external.go#L232-L247
[external-implicit]: https://github.com/supabase/auth/blob/10ef10789d1ee4fb422b448047e67e3e264c0482/internal/api/external.go#L248-L255
[external-implicit-url]: https://github.com/supabase/auth/blob/10ef10789d1ee4fb422b448047e67e3e264c0482/internal/api/external.go#L286-L295
[external-exists]: https://github.com/supabase/auth/blob/10ef10789d1ee4fb422b448047e67e3e264c0482/internal/api/external.go#L384-L397
[token-pkce]: https://github.com/supabase/auth/blob/10ef10789d1ee4fb422b448047e67e3e264c0482/internal/api/token.go#L326-L352
[token-field]: https://github.com/supabase/auth/blob/10ef10789d1ee4fb422b448047e67e3e264c0482/internal/tokens/service.go#L119
[linking]: https://github.com/supabase/auth/blob/10ef10789d1ee4fb422b448047e67e3e264c0482/internal/models/linking.go#L56-L200
[user-meta]: https://github.com/supabase/auth/blob/10ef10789d1ee4fb422b448047e67e3e264c0482/internal/models/user.go#L230-L243
[user-providers]: https://github.com/supabase/auth/blob/10ef10789d1ee4fb422b448047e67e3e264c0482/internal/models/user.go#L262-L274
[identity-order]: https://github.com/supabase/auth/blob/10ef10789d1ee4fb422b448047e67e3e264c0482/internal/models/identity.go#L109-L126
[factor]: https://github.com/supabase/auth/blob/10ef10789d1ee4fb422b448047e67e3e264c0482/internal/models/factor.go#L75-L78
[amr]: https://github.com/supabase/auth/blob/10ef10789d1ee4fb422b448047e67e3e264c0482/internal/models/sessions.go#L390-L407
[admin-delete]: https://github.com/supabase/auth/blob/10ef10789d1ee4fb422b448047e67e3e264c0482/internal/api/admin.go#L595-L660
[cleanup]: https://github.com/supabase/auth/blob/10ef10789d1ee4fb422b448047e67e3e264c0482/internal/models/cleanup.go#L60
[tfp-settings]: https://github.com/supabase/terraform-provider-supabase/blob/a9e8b074d4bda3bd3d8de2805b63bb3d4b1d56cd/docs/resources/settings.md
[tfp-preserve]: https://github.com/supabase/terraform-provider-supabase/blob/a9e8b074d4bda3bd3d8de2805b63bb3d4b1d56cd/internal/provider/settings_resource.go#L878-L889
[tfp-test]: https://github.com/supabase/terraform-provider-supabase/blob/a9e8b074d4bda3bd3d8de2805b63bb3d4b1d56cd/internal/provider/settings_resource_test.go#L811-L905
[mgmt-api]: https://api.supabase.com/api/v1-json
[sb-apple]: https://supabase.com/docs/guides/auth/social-login/auth-apple
[sb-linking]: https://supabase.com/docs/guides/auth/auth-identity-linking
[apple-secret]: https://developer.apple.com/documentation/accountorganizationaldatasharing/creating-a-client-secret
[apple-token]: https://developer.apple.com/documentation/signinwithapplerestapi/generate-and-validate-tokens
[apple-tokenresponse]: https://developer.apple.com/documentation/signinwithapplerestapi/tokenresponse
[apple-revoke]: https://developer.apple.com/documentation/signinwithapplerestapi/revoke-tokens
[apple-auth]: https://developer.apple.com/documentation/signinwithapple/authenticating-users-with-sign-in-with-apple
[apple-verify]: https://developer.apple.com/documentation/signinwithapple/verifying-a-user
[apple-fullname]: https://developer.apple.com/documentation/authenticationservices/asauthorizationappleidcredential/fullname
[apple-relay]: https://developer.apple.com/documentation/signinwithapple/communicating-using-the-private-email-relay-service

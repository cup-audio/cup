# What Apple requires of an app that offers Sign in with Apple

Research date: 2026-11-18, for [issue #466](https://github.com/cup-audio/cup/issues/466) of the [Sign in with Apple map](https://github.com/cup-audio/cup/issues/465). Every Apple source below was read on 2026-11-18. Apple's developer documentation pages were read from their DocC JSON (`https://developer.apple.com/tutorials/data/<path>.json`), which is the content the rendered page shows; the App Review Guidelines and the account deletion support page were read as HTML. Neither of those two pages shows a "last updated" date, so the observation date is the only date this note can give for them.

## Question

Which current Apple rules bind Cup once it offers Sign in with Apple: guideline 4.8 (does Cup's Google sign-in trigger it, and does Apple satisfy it), the Human Interface Guidelines for the button, token revocation on account deletion (guideline 5.1.1(v)), the Private Email Relay and sender registration, server-to-server notifications and whether they are required, and whether an app may require a name or email. Revalidate the Apple findings in [`docs/research/social-signup/`](../social-signup/).

## Answer

- **4.8 binds Cup's iOS app, and Sign in with Apple satisfies it.** Cup's iOS app uses Google Sign-In for the user's primary account, so it "must also offer as an equivalent option another login service" that limits data to name and email, lets users keep their email private, and does not collect interactions for advertising without consent. None of the five exceptions fits Cup. The rule no longer names Sign in with Apple; any service with those three properties passes, and Sign in with Apple has all three by Apple's own description ([4.8][guidelines]).
- **The button is a design rule App Review checks.** Sign in with Apple must be "no smaller than other sign-in buttons", must not need scrolling to see, uses only the titles "Sign in with Apple", "Sign up with Apple" or "Continue with Apple", in black, white or white-with-outline, at least 140 × 30 pt with a margin of 1/10 of its height. Custom buttons are allowed with Apple's logo artwork, and "App Review evaluates all custom Sign in with Apple buttons" ([HIG][hig]).
- **Account deletion must revoke Apple's tokens.** Apple's account deletion page says apps with Sign in with Apple "should use the Sign in with Apple REST API to revoke user tokens"; revocation needs a refresh or access token, which only the server-side exchange of the authorization code yields ([deletion][deletion], [revoke][revoke], [TN3194][tn3194]).
- **Mail to Hide My Email addresses needs registered senders.** Cup must register its outbound domains or addresses as email sources and authenticate them with SPF, DKIM or both; unregistered mail does not reach the user ([environment][environment]).
- **Server-to-server notifications are recommended, not required, outside South Korea.** Apple's deletion page says to "use server-to-server notification endpoints", and requires one only of developers based in the Republic of Korea; native apps can instead observe credential revocation on the device ([deletion][deletion], [TN3194][tn3194]).
- **Cup may not require a name or an email the user has not chosen to give.** Guideline 5.1.1(x) allows asking for name and email only if "the request is optional"; Apple hands over the name once, on first authorization, and the user may answer the email request with a private relay address that Cup must not override ([guidelines][guidelines], [HIG][hig], [authenticating][authenticating]).

## Guideline 4.8, Login Services

The current text: "Apps that use a third-party or social login service (such as Facebook Login, Google Sign-In, Log in with X, Sign In with LinkedIn, Login with Amazon, or WeChat Login) to set up or authenticate the user's primary account with the app must also offer as an equivalent option another login service with the following features" ([guidelines][guidelines]):

- the login service limits data collection to the user's name and email address;
- the login service allows users to keep their email address private as part of setting up their account; and
- the login service does not collect interactions with your app for advertising purposes without consent.

A primary account is "the account they establish with your app for the purposes of identifying themselves, signing in, and accessing your features and associated services". Cup's Cup account is exactly that, and Google is today its only sign-in method on iOS (ADR 0019), so 4.8 applies to the iOS app as soon as it is submitted to the App Store with Google sign-in.

The five exceptions are: the app uses exclusively the company's own account system; an alternative app marketplace login; an education, enterprise or business app requiring an existing institutional account; a government or industry-backed electronic ID; a client for a specific third-party service whose content the user reaches by signing in to that service. None fits Cup: Cup has no own credentials, and Google sign-in is not used to reach Google content.

Sign in with Apple has the three required properties by Apple's own description: it returns only name and email ([authenticating][authenticating]), offers a private relay address ([HIG][hig], [relay][relay]), and "Apple doesn't use Sign in with Apple to profile people or their activity in apps" ([HIG][hig]). The guideline itself no longer names Sign in with Apple, so the map could in principle pick another qualifying service; Apple is the obvious one because it is what the map plans.

4.8 binds only the App Store build. The web app and the Android app are outside App Review, so Apple sign-in there is Cup's choice, not Apple's requirement.

## Human Interface Guidelines for the button

The [Sign in with Apple HIG page][hig] (change log: last change 2022-09-14) sets:

- **Prominence.** "Make a Sign in with Apple button no smaller than other sign-in buttons, and avoid making people scroll to see the button." Order is not prescribed, only size and visibility.
- **System button.** Prefer the system button (`ASAuthorizationAppleIDButton` on iOS, Apple's JS button on the web): it guarantees an approved look, localizes the title, supplies a VoiceOver label and lets the corner radius match the app's other buttons.
- **Titles.** Only "Sign in with Apple", "Sign up with Apple" or "Continue with Apple"; pick the variant that fits the app's terminology and use it consistently.
- **Appearance.** White (dark backgrounds), white with outline (light backgrounds), black (light backgrounds; never on dark).
- **Size.** Minimum 140 pt wide, 30 pt tall, margin 1/10 of the button's height; 44 pt is the default and recommended iOS height.
- **Custom buttons.** Allowed on iOS, macOS and the web, with logo artwork from Apple Design Resources only. Logo and title must both be black or white; logo-and-text buttons are rectangular; logo-only buttons are 1:1, may be masked to a circle; the title font size is 43 % of the button height; at least 8 % of the width stays free right of the title. Title font, case, background texture, corner radius, bezel and shadow may change. "App Review evaluates all custom Sign in with Apple buttons."
- **Flow.** Do not ask for a password; do not ask for a personal email when the user chose a relay address; ask for additional data only when needed and say whether it is required; show the current sign-in method ("Using Sign in with Apple") in account settings.

## Account deletion and token revocation

Guideline 5.1.1(v): "If your app supports account creation, you must also offer account deletion within the app" ([guidelines][guidelines]). The [account deletion support page][deletion] adds: deletion must be easy to find and delete the whole account record (deactivation alone is insufficient); a link to a web page that finishes deletion is allowed; confirmation and identity verification steps are allowed, but "apps that make it unnecessarily difficult for someone to delete their account will not pass review"; a delay is fine if the user is told how long it takes and gets a confirmation; apps outside regulated industries must not require a phone call, email or support chat.

On Sign in with Apple, the page states, verbatim: "Apps that support Sign in with Apple should use the Sign in with Apple REST API to revoke user tokens." It then says to "Use server-to-server notification endpoints to process changes for Sign in with Apple accounts" and "Note that developers based in the Republic of Korea must provide a server‑to‑server notification endpoint when registering a new Services ID."

The [revocation endpoint][revoke] is `POST https://appleid.apple.com/auth/revoke`, form-encoded, with `client_id` (the App ID or Services ID used in the authorization, without the Team ID), `client_secret` (a JWT signed with the Sign in with Apple private key), `token` (a refresh or access token) and `token_type_hint`. It returns `200` with no body when the token is revoked "or was previously invalid", so retries are safe. An identity token cannot be revoked; tokens come from validating the authorization code at `/auth/token`.

[TN3194][tn3194] (first published 2025-10-03, newer than Cup's prior research) is Apple's current guidance for the whole lifecycle:

- `/auth/revoke` "is the only way to programmatically invalidate user tokens associated to your developer account without user interaction".
- On account creation: send the identity token and authorization code to the server, verify the identity token, validate the code at `/auth/token`, store the identity, refresh and access tokens, and validate the refresh token "up to once per day".
- Without a refresh token, access token or authorization code, Cup "must still fulfill the user's account deletion request": delete the data, direct the user to revoke access manually, and react to the credential-revoked notification. If the user does not revoke manually, the next Apple sign-in skips the name and email request, because Apple still reports the credential as authorized.
- On a credential-revoked event (native `credentialRevokedNotification`, or the web `consent-revoked` notification), delete the user's account data including the stored revocation token, and return the client to a signed-out state.

The [client secret][client-secret] JWT may expire at most 15,777,000 seconds (six months) after issue, so Cup's server either mints it on demand from the private key or rotates a stored one. Each primary App ID can have at most two Sign in with Apple private keys ([environment][environment]).

Guideline 5.1.1(v) also says "An app may not store credentials or tokens to social networks off of the device". That sentence is about apps whose core is a social network such as Facebook or X; Apple's own TN3194 tells apps to store Sign in with Apple tokens on their server, so it does not forbid server-side custody of Apple refresh tokens.

## Private Email Relay

From [Communicating using the private email relay service][relay] and [Configuring your environment][environment]:

- Relay addresses end in `@privaterelay.appleid.com`, `@private.icloud.com` or `@icloud.com`, forward to a verified address of the Apple Account, and are the same for a user across all apps of one developer team and different across teams.
- To send to them, Cup must register its outbound email domains, subdomains or addresses as email sources in Certificates, Identifiers & Profiles (up to 32 for an individual membership, 100 for an organization), and "must authenticate all registered domains with the Sender Policy Framework (SPF), the DomainKeys Identified Mail (DKIM) protocol, or both"; Apple asks for both whenever possible. Email sources belong to the Team ID, so registration happens on the team the map decides on.
- Each relay address has a limit of 100 emails per day, counting both directions.
- When the relay detects undelivered mail it notifies the team's account holders and admins by email.
- A user can turn forwarding off; the relay then rejects all mail to that address, for every app of the team.

For Cup this means registering the Resend sending domain that delivers deletion notices ([production configuration](../../production-configuration.md)) on the chosen Apple team, with Resend's SPF and DKIM records in place.

## Server-to-server notifications

[Processing changes for Sign in with Apple accounts][notifications] describes one HTTPS endpoint per app group (TLS 1.2 or later), registered on the App ID. Apple POSTs a JSON body `{ "payload": "<JWS>" }`, signed by Apple's key; the `events.type` claim is one of:

| Event             | Meaning                                                           |
| ----------------- | ----------------------------------------------------------------- |
| `email-disabled`  | The user stopped forwarding mail to the relay address             |
| `email-enabled`   | The user turned forwarding back on                                |
| `consent-revoked` | The user stopped using Sign in with Apple with the app (or group) |
| `account-deleted` | The user permanently deleted the Apple Account                    |

There is no event for a change of the user's real email address; only forwarding on/off for a relay address is signalled. When an Apple Account is deleted, Apple "invalidates all user tokens and disables email forwarding for all associated apps", and native apps get no `credentialRevokedNotification`; they must check `getCredentialState(forUserID:)`.

Required? Apple's guidance says to use them ("Use server-to-server notification endpoints", "enable the ... endpoint" to "receive important updates"), but the only explicit requirement is for developers based in the Republic of Korea when registering a new Services ID ([deletion][deletion]). Nothing in the App Review Guidelines requires the endpoint. TN3194 accepts either the native notification or the server notification as the trigger for clean-up, so an endpoint is the only way Cup learns of a revocation made while the user never opens the app or uses only the web.

## Name and email

- Guideline 5.1.1(v): apps "may not require users to enter personal information to function, except when directly relevant to the core functionality of the app or required by law"; 5.1.1(x): apps "may request basic contact information (such as name and email address) so long as the request is optional for the user, features and services are not conditional on providing the information" ([guidelines][guidelines]).
- The HIG says not to ask for a personal email when the user chose a relay address, and that data that is "legally or contractually required" must be marked as required ([HIG][hig]).
- Apple shares the name and email only "the first time the user logs in"; later responses carry the email in the identity token but not the name, and the name is not in the identity token at all ([authenticating][authenticating], [`fullName`][fullname]). Cup must store the name from the first native response, because it cannot get it again unless the user revokes and reconnects. Apple advises sanitizing the user-submitted name.
- When the app requests the email scope, the user chooses between sharing the real address and a relay address, so Cup always gets a deliverable address but cannot require the real one.

For Cup: requesting name and email is allowed; requiring a real email or a name the user did not give is not. Cup's deletion notices can go to the relay address.

## Further constraints relevant to the map

- **Web needs an App Store app.** "For users to authenticate with your web service, you must have an existing app in the App Store that uses Sign in with Apple" ([environment][environment]); the web flow uses a Services ID grouped with that primary App ID, with registered and verified domains and absolute return URLs (an individual membership may register 10 website URLs, an organization 100).
- **Team scoping.** User identifiers, relay addresses, email sources and keys belong to the developer team; moving users to another team needs Apple's transfer process ([transfer][transfer]). This confirms the map's note that the team is decided before real users sign in.
- **Grouping.** Grouping App IDs makes the consent sheet appear once per group of apps and websites ([authenticating][authenticating]).

## Revalidation of `docs/research/social-signup/`

| Prior claim                                                                                                                                                                                                     | Source file                                                                     | Status on 2026-11-18                                                                                                                                                                            |
| --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Apps supporting account creation must offer in-app deletion; deactivation is insufficient; confirmation and reauthentication allowed; timeframe and confirmation required                                       | [account-deletion-research.md](../social-signup/account-deletion-research.md)   | Confirmed ([deletion][deletion])                                                                                                                                                                |
| Apps supporting Sign in with Apple should revoke tokens with the REST API                                                                                                                                       | account-deletion-research.md                                                    | Confirmed, same wording ([deletion][deletion])                                                                                                                                                  |
| Revocation needs an access or refresh token, the matching App ID or Services ID and a client-secret JWT; an identity token is no substitute; an authorization code yields revocable tokens                      | account-deletion-research.md                                                    | Confirmed ([revoke][revoke]); the endpoint also answers 200 for an already-invalid token                                                                                                        |
| Apple recommends sending identity token and code to the server and storing the tokens; without credentials, still fulfil deletion and direct the user to revoke manually; native and server notifications exist | account-deletion-research.md (cites TN3194)                                     | Confirmed; TN3194 also says to validate the refresh token at most once per day and that skipping manual revocation suppresses the name and email request on the next sign-in ([TN3194][tn3194]) |
| Native Apple sign-in is AuthenticationServices' authorization sheet; a browser, Safari view or `ASWebAuthenticationSession` does not qualify as native                                                          | [native-social-sso-research.md](../social-signup/native-social-sso-research.md) | Consistent with Apple's documentation; this is Cup's definition of "native", not an Apple rule. Apple does not forbid a web flow on iOS; the map's decision to use the native sheet is Cup's    |
| Register the email sender with the private relay and verify Hide My Email delivery                                                                                                                              | [deferred-apple-ios.md](../social-signup/deferred-apple-ios.md)                 | Confirmed and sharpened: register sources per team, SPF and/or DKIM, 100 mails per address per day ([environment][environment], [relay][relay])                                                 |
| Configure identifiers, capabilities, services and credentials                                                                                                                                                   | deferred-apple-ios.md                                                           | Still accurate; adds the web flow's dependency on an App Store app, two keys per primary App ID and the six-month client-secret limit                                                           |

The prior files do not mention guideline 4.8 or the HIG; both are new in this note. No prior Apple claim was found to be wrong.

## Sources

All read 2026-11-18.

- [App Review Guidelines][guidelines], sections 4.8 and 5.1.1(v) and (x); page shows no revision date.
- [Offering account deletion in your app][deletion]; page shows no revision date.
- [Human Interface Guidelines: Sign in with Apple][hig]; change log entry 2022-09-14.
- [TN3194: Handling account deletions and revoking tokens for Sign in with Apple][tn3194]; first published 2025-10-03.
- [Sign in with Apple REST API: Token revocation][revoke].
- [Creating a client secret][client-secret].
- [Configuring your environment for Sign in with Apple][environment].
- [Communicating using the private email relay service][relay].
- [Processing changes for Sign in with Apple accounts][notifications].
- [Authenticating users with Sign in with Apple][authenticating].
- [`ASAuthorizationAppleIDCredential.fullName`][fullname].
- [Transferring your apps and users to another team][transfer].

[guidelines]: https://developer.apple.com/app-store/review/guidelines/
[deletion]: https://developer.apple.com/support/offering-account-deletion-in-your-app/
[hig]: https://developer.apple.com/design/human-interface-guidelines/sign-in-with-apple
[tn3194]: https://developer.apple.com/documentation/technotes/tn3194-handling-account-deletions-and-revoking-tokens-for-sign-in-with-apple
[revoke]: https://developer.apple.com/documentation/signinwithapplerestapi/revoke-tokens
[client-secret]: https://developer.apple.com/documentation/accountorganizationaldatasharing/creating-a-client-secret
[environment]: https://developer.apple.com/documentation/signinwithapple/configuring-your-environment-for-sign-in-with-apple
[relay]: https://developer.apple.com/documentation/signinwithapple/communicating-using-the-private-email-relay-service
[notifications]: https://developer.apple.com/documentation/signinwithapple/processing-changes-for-sign-in-with-apple-accounts
[authenticating]: https://developer.apple.com/documentation/signinwithapple/authenticating-users-with-sign-in-with-apple
[fullname]: https://developer.apple.com/documentation/authenticationservices/asauthorizationappleidcredential/fullname
[transfer]: https://developer.apple.com/documentation/signinwithapple/transferring-your-apps-and-users-to-another-team

---
status: accepted
---

# Keep IP addresses, locations, credentials and device identifiers out of telemetry

Cup's telemetry identifies a listener by an opaque account ID at most. [ADR 0030](0030-observe-production-with-sentrys-own-sdks-and-turn-cloudflares-observability-off.md) enforces privacy in Cup's hooks and again in Sentry's organisation scrubbing rules, and [ADR 0031](0031-capture-native-crashes-in-the-shells-without-consent-keeping-no-installation-id-on-the-device.md) keeps the native SDKs' installation ID off the device. Sentry's SDKs add identifying data in several places Cup does not control directly, so each privacy hook removes it. These rules were decided with the observability spec [cup-audio/cup#403](https://github.com/cup-audio/cup/issues/403) for Linear CUP-37 and implemented in [cup-audio/cup#422](https://github.com/cup-audio/cup/pull/422). These decisions were recorded from code comments on 2026-11-23.

## Decision

- **Credential-carrying URL parameters are masked everywhere, the rest of the URL kept** ([URL masking](../../libs/telemetry.core/src/url-masking.ts)). Signed media URLs carry their credential in `token`, and OAuth callbacks carry `code` and `access_token`: a URL that reaches telemetry with one of these could be replayed. Every privacy hook (`beforeSend`, `beforeSendSpan`, `beforeSendLog`, `beforeBreadcrumb`) masks them with one function and keeps the rest of the URL, so the source URL stays readable. A masked value becomes `[Filtered]`, the marker Sentry's own scrubbers use. A parameter matches only at the start of the text or after `?`, `&` or `;`, so `monkey=` never matches `key=`; its value ends at the next parameter, fragment, whitespace or quote.
- **No IP address and no IP headers.** The headers that carry the listener's IP address are the ones Cloudflare sets plus `X-Vercel-Forwarded-For`, which Sentry's `handleTunnelRequest` also reads ([client IP headers](../../libs/telemetry.cloudflare/src/client-ip-headers.ts)); telemetry sends none of them.
- **No time zone.** The Worker SDK copies `request.cf.timezone` onto spans and, as the `culture` context, onto events: a location finer than the country, which telemetry never keeps. The Worker's `beforeSend` and `beforeSendSpan` drop it ([server before-send](../../libs/telemetry.cloudflare/src/server-before-send.ts)).
- **Log attributes never carry an email** ([log event](../../libs/telemetry.cloudflare/src/log-event.ts)).
- **The client sends only the opaque user ID, no IP address, no device identifiers, masked URLs** ([client before-send](../../libs/telemetry.browser/src/client-before-send.ts)). The device identifiers are those a native SDK copies onto JS events through scope sync; the organisation's scrubbing rule removes them again at ingest. `beforeBreadcrumb` masks URLs in the message and in every string of its data, such as a request's `url` or a navigation's `from` and `to`, because scope sync copies breadcrumbs onto native events, which no `beforeSend` of Cup's sees.
- **The user rule** ([telemetry user](../../libs/telemetry.browser/src/telemetry-user.ts)): telemetry's user is the opaque account ID once a signed-in listener's account is known, and `signed-out` otherwise, sign-out and account deletion included. The auth subject never becomes the user, and the user is never unset, because `setUser(null)` would let a native SDK fill in its installation ID ([`SIGNED_OUT_USER`](../../libs/telemetry.core/src/telemetry-attributes.ts)). A failed account load leaves the user signed out; the failed request is a breadcrumb.
- **Trace linking across page loads is session-scoped** (`linkPreviousTrace: "session-storage"`), not a telemetry identifier; the privacy policy names it ([client Sentry options](../../libs/telemetry.browser/src/client-sentry-options.ts)).

## Consequences

- A new credential query parameter must join `MASKED_QUERY_PARAMETERS`.
- Locations reach Sentry only as the listener's country, which the telemetry tunnel sets.

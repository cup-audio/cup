---
status: accepted
---

# Authorize media and position requests with stateless signed URLs

The web player, the Android and iOS apps and the native players load the narration track and the cover image with plain `<audio>` and `<img>` elements, which cannot send the listener's bearer token, and the apps save the listening position from players that do not hold the listener's session. The listener API therefore hands out signed media URLs and signed position URLs. These decisions were introduced with the single narration track in [cup-audio/cup#73](https://github.com/cup-audio/cup/pull/73), refined with the daily cover cache in [cup-audio/cup#101](https://github.com/cup-audio/cup/pull/101) ([ADR 0013](0013-cache-cover-images-in-the-browser-for-a-day.md)), extended with position URLs for the native Android player in [cup-audio/cup#401](https://github.com/cup-audio/cup/pull/401) (CUP-41, CUP-71), and with the cross-origin embed policy in [cup-audio/cup#256](https://github.com/cup-audio/cup/pull/256) (CUP-44). They were recorded from code comments on 2026-11-23. [Authentication](../architecture/authentication.md) and [playback](../architecture/playback.md) describe the current behaviour.

## Decision

The [signed media URL module](../../libs/api-server/src/http/signed-media-url.ts) and the [server composition](../../libs/api-server/src/api-server.ts) implement these rules:

- **Principal.** A signed URL is issued to the account or the grant that owned the audiobook when the URL was issued. Delivery checks this principal's current access on every request. URLs are signed on the request's origin for one principal, which must have access when they are issued.
- **Purpose.** A token without a purpose is a media token and authorizes the media routes under `/api/files/audiobooks/{conversionId}/`. A `"position"` token authorizes only the listening-position route; that URL is the signed position URL. Each route accepts only its own kind.
- **Stateless token.** The token is a `token` query parameter that authorizes requests to one URL, for one audiobook and one principal. It is stateless, so rotating the signing key (`MEDIA_URL_SIGNING_KEY` in the [environment](../../libs/api-server/src/api-server-environment.ts)) invalidates every outstanding URL.
- **Lifetime.** A signed URL authorizes requests until a fixed lifetime after its issue time, which is the start of the UTC day it was handed out on, so every URL stays valid for at least 24 hours after it is handed out. Within one UTC day the same URL and principal get a byte-identical URL, which lets browsers cache cover images (ADR 0013). The principal is rebuilt in a fixed key order, so equal principals always encode to the same token, and a `purpose` is added to the payload last, so tokens without one stay byte-identical to the media tokens issued before purposes existed.
- **Local lifetime.** Only in local development, read with `LOCAL_DEVELOPMENT=true`, `LOCAL_SIGNED_URL_LIFETIME_SECONDS` makes signed media and position URLs expire that many seconds after they are handed out, so the mobile E2E suite sees them expire within a test. Everywhere else the setting is `undefined`.
- **Position saves.** A listening-position save is authorized by exactly one credential: the listener's bearer token or a signed position URL's `token`. Either way the save goes to an active account, which must own the audiobook. With the bearer token, a trial audiobook that the request's grant session covers counts too, so a signed-in listener saves a trial audiobook's position to their account; a position URL never authorizes such a save. Only account principals get a `positionUrl`, which lets a client save the position without the listener's session. Sign-out does not revoke a position URL; it stays valid until it expires. The position route authorizes either credential and checks ownership itself (`authorizePositionSave`), so the ownership middleware passes it through.
- **Exact media routes.** Media routes accept only a signed media URL. Registering the exact media routes, as `allowedMethodsForApiPath` lists them, lets other paths under `/api/files/` answer 404 instead of 401.
- **Cross-origin embeds.** The Android and iOS apps embed media from their own origins (`https://localhost` on Android, `capacitor://localhost` on iOS) with plain `<img>` and `<audio>` elements. A signed media URL authorizes the request by itself, so its routes answer with `Cross-Origin-Resource-Policy: cross-origin`; credentialed CORS still admits only the app's origins. The web app's Content Security Policy admits the narration track as `media-src` on this origin's `/api/files/` routes.

Verification ([signed media URL module](../../libs/api-server/src/http/signed-media-url.ts)):

- Checking a request's `token` covers its signature (verified in constant time), its expiry, that it was issued for this audiobook, and that it carries exactly the route's purpose (none for a media token). The principal's current access is a separate, authoritative check: the principal must still own the audiobook, as an active account or an unexpired, unrevoked grant, and denials answer as the same request with the account's or grant's own credentials would.
- A signed media URL token is the only credential media routes accept. Without an owner, the route answers its own not-found response.
- A position save checks the position token's signature, expiry, purpose and audiobook, then that the account it names still owns the audiobook and is active, answered as a media request with a media token would be. Whether the audiobook still exists is the route's check. Position URLs are issued to accounts only, so an audiobook without an account owner is not this account's: it answers not found, not the trial's grant-session answer.

## Consequences

- A leaked signed URL works for anyone until it expires, but only while its principal still has access; rotating the signing key is the way to revoke every URL at once.
- Cover image URLs stay byte-identical for a UTC day, which ADR 0013's browser cache depends on; changing the token encoding or payload order breaks that cache for one day.
- The [narration track tests](../../libs/api-server/test/narration-track.test.ts) check that the resource policy does not block the apps' cross-origin embed.

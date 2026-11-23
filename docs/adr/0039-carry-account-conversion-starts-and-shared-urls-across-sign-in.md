---
status: accepted
---

# Carry account conversion starts and shared URLs across sign-in

A listener starts an account conversion from a source URL on the home page or in the Add a Track sheet, may have to sign in first, and may arrive with a URL shared into the app. [`useAccountConversionSubmission`](../../apps/web-app/src/app/use-cases/account-conversions.ts), the [start conversion form](../../apps/web-app/src/app/components/start-conversion-form.tsx), the [Add dialog](../../apps/web-app/src/app/components/add-audiobook-dialog.tsx), the [source URL form](../../apps/web-app/src/app/components/source-url-form.tsx) and the [signed-in home target](../../apps/web-app/src/app/signed-in-home-target.ts) decide where a start and a shared URL go. The rules came with [cup-audio/cup#101](https://github.com/cup-audio/cup/pull/101) (the Recents redesign and the Add dialog), [cup-audio/cup#116](https://github.com/cup-audio/cup/pull/116) (account dialog and account recovery page), [cup-audio/cup#256](https://github.com/cup-audio/cup/pull/256) (sign in from the home page without a source URL) and [cup-audio/cup#287](https://github.com/cup-audio/cup/pull/287) (start the conversion as soon as a link is shared into the app). These decisions were recorded from code comments on 2026-11-23.

## Decision

- **Where a pending start lives.** With `requestStorage: "session"` the pending request lives in `sessionStorage`, so the home page's start survives the OAuth redirect and resumes when home mounts again. With `"memory"` it lives only as long as the mounted form: the Add dialog's start never resumes on home or in a later dialog.
- **Where a sign-in completes.** An in-place sign-in (the test account, Android's native sign-in, iOS's browser sheet) completes on the page, so the page leaves for where it sends a signed-in listener itself; a web Google sign-in returns through the OAuth redirect instead, and a submitted request resumes there. Leaving after a sign-in from the home page's link replaces the history entry, as the home route's redirect does, so Back does not return to the signed-out home page.
- **The sign-in link drops an unsubmitted request.** Signing in from the sign-in link first drops a stored request that was never submitted, so the sign-in lands where home sends a signed-in listener. Only a submission's sign-in marks its stored request unsubmitted when it closes. The entry that opened the sign-in is kept after it closes, so its copy and the focus it returns to stay with that entry.
- **Where a signed-in listener lands.** Home sends a signed-in listener to Recents, or to the Add dialog while a shared URL waits for a form to take it, because share intake sends a signed-in listener there too.
- **A shared URL goes to the form that stays.** A URL shared to the app fills the field and submits it, so its conversion starts right away; one shared while a start is pending or rate-limited waits until the form can submit again. The form takes a share only when it can be submitted, which keeps the guard in `onSubmit` from dropping it. A form that may still be replaced or is going away does not take it: the home form waits until auth settles, since a signed-in listener may still be redirected to the Add dialog, which takes the shared URL instead, and a closing Add sheet leaves it for the next form.
- **The Add dialog relies on the start's invalidation.** It closes once the start succeeded without invalidating anything itself, because the start mutation has already invalidated the history query that Recents lists.
- **The recovery page does not finish a dialog's deletion.** A deletion begun in the account dialog but not confirmed stays stored for this tab; the account recovery page must not offer to finish it ([account settings](../../apps/web-app/src/app/components/account-settings.tsx)).

## Consequences

- A start from home survives a full-page OAuth round trip within the tab; a start in the Add dialog is lost when the dialog closes.
- A shared URL is not dropped by a form that is about to be replaced or cannot submit yet.

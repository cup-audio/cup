---
status: accepted
---

# Order a conversion deletion so no screen shows or requests the deleted track

An account can delete a conversion forever ([cup-audio/cup#138](https://github.com/cup-audio/cup/pull/138)). Between the deletion request and the listener landing on Recents, a poll, a history request already in flight, or the cached history list could show the deleted track again or ask for it and fail. [cup-audio/cup#165](https://github.com/cup-audio/cup/pull/165) set the order of the steps, and [cup-audio/cup#116](https://github.com/cup-audio/cup/pull/116) and the commit "feat(accounts): add social signup and account lifecycle" handled account deletion. These decisions were recorded from code comments on 2026-11-23.

## Decision

The [conversion deletion](../../apps/web-app/src/data-fetching/reader.ts) runs its steps in this order:

1. Confirming releases the track from the player host before the request, so no part of the app plays the track while it is deleted. The delete dialog gives Cancel the focus, as the safe choice, and Escape cannot abandon a deletion that runs.
2. The [detail view](../../apps/web-app/src/routes/_shell.audiobooks.$conversionId.tsx) stops polling the audiobook before the deletion is sent, since a poll answered during or after the deletion would find the track gone and report a failure.
3. A conversion already gone counts as deleted, and the dialog that starts the deletion shows a failure in place of a toast.
4. The cached history pages drop the conversion before the page is left, so Recents never renders the deleted track from its cached list. Removing it first cancels history requests in flight, because one sent before the deletion would put the conversion back ([account history](../../apps/web-app/src/data-fetching/account-history.ts)). The caller invalidates the history afterwards.
5. The page is left before its audiobook query is dropped, so the page cannot request the deleted audiobook again. Either way of returning to Recents keeps Back from returning to the deleted track: going back leaves it as the Forward entry, which leads to the not-found error screen, and replacing drops it.
6. "Track deleted." is announced once the dialog is gone, because the open dialog hides the rest of the page from screen readers.

A scheduled account deletion blocks the account, so only the account snapshot is requested again before the sign-out clears the cache ([account confirmation](../../apps/web-app/src/data-fetching/account-confirmation.ts)). A restore also lets Recents behind the account dialog list the history it failed to list for the blocked account.

## Consequences

- No failure notice appears for a track the listener just deleted.
- Any new query that holds a conversion must be dropped or stopped in the same order, or it can bring the deleted track back.

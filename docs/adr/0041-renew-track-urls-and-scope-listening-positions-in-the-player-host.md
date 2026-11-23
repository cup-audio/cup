---
status: accepted
---

# Renew track URLs by their age on the client and scope listening positions to the loaded account

The [player host](../../apps/web-app/src/app/player/player-host.ts) keeps one audiobook loaded while the listener navigates, and its lifecycle is the XState machine that [ADR 0034](0034-model-the-player-host-and-position-saves-as-xstate-machines.md) describes. Two questions it must answer are not covered there: when a signed narration track URL ([ADR 0011](0011-serve-one-narration-track-and-play-it-with-one-audio-element.md), lifetime changed by [ADR 0013](0013-cache-cover-images-in-the-browser-for-a-day.md)) is too old to play, and whose listening position a loaded audiobook reads and writes. The rules grew in [cup-audio/cup#9](https://github.com/cup-audio/cup/pull/9) (the player host owns the reader's playback rules), [cup-audio/cup#10](https://github.com/cup-audio/cup/pull/10) (one playback session in front of both players), [cup-audio/cup#138](https://github.com/cup-audio/cup/pull/138) (deleting a conversion forever), [cup-audio/cup#401](https://github.com/cup-audio/cup/pull/401) (native Android player and its takeover) and [cup-audio/cup#460](https://github.com/cup-audio/cup/pull/460) (the machines). These decisions were recorded from code comments on 2026-11-23.

## Decision

### Track URL renewal

- **Renewal age.** The signed URL stays valid for at least 24 hours after the server handed it out, by the server clock. Play renews a URL older than half of that, which tolerates a skewed client clock ([player host machine](../../apps/web-app/src/app/player/player-host-machine.ts)).
- **What dates a URL.** `receivedAt` is when the client received the audiobook, by the client clock. A page passes the time its cached response arrived, the query's `dataUpdatedAt` ([player host provider](../../apps/web-app/src/app/player/player-host-provider.tsx)), which can lie long before the page showed it; without one, the audiobook counts as received now. A listener's load dates the track URL; a takeover of what already plays does not know its age, and a session whose URLs came from an earlier page renews them on its first Play.
- **What needs a new URL.** A media error, or a track URL older than the renewal age, needs a newly signed URL. Play then requests the audiobook again and sets the new URL at the same position. When the renewal request fails, the request layer reports the failure itself, and the player only shows that Play did not start.

### The Android app's native player

- **A failed native load keeps its URL.** In the [native-backed player](../../apps/web-app/src/app/player/native-track-player.ts) a failed load is retried at the same URL; ExoPlayer prepares the item again on Play. Only expired URLs, or a session taken over with URLs of unknown age, need new ones.
- **The page reads the plugin's state again when it becomes visible**, because events sent while the WebView suspended the hidden page can be lost.

### Listening positions and accounts

- **A position belongs to the user the audiobook was loaded for.** A change of the signed-in user unloads the audiobook. A position save must refuse to write when another account is signed in by the time the request is sent ([playback session](../../apps/web-app/src/app/player/playback-session.ts)).
- **Device-only positions are read again.** A listener without an account keeps the listening position only on the device, where the shown audiobook does not see it change, so the host reads the shown audiobook's resume position again after playback moved it.
- **Deleting a conversion unloads it without saving.** Its position is not saved, since that save would race the deletion. Only Play on its page loads it again, also when the deletion fails.
- **Taking over what already plays checks the audiobook and the account.** Takeover runs once, for what already plays when the page starts, such as the Android app's native session after a reload, a renderer crash, a live update or a relaunch: it fetches that audiobook and makes it the loaded one without loading it again, so playback goes on and the mini player shows it. A deleted audiobook, one that lost its narration track, or one loaded for another account ends the session instead. When fetching the audiobook fails, the request layer reports the failure itself, the session plays on, and the next load replaces it.

### React and XState details

- The provider defers its reaction to the auth store, because the auth store can publish while a page renders.
- A page reports the conversion it shows from a layout effect, before the first paint, so its controls never flash.
- XState counts a transition that queued an effect as handled even when it returns no target or context; a start of the loaded audiobook relies on that to act on the loaded player without loading anything.
- XState's docs write payload-less events as `types<{}>()`, which the lint forbids as an empty type; the machine's schema declares them as `z.object({})`.

## Consequences

- A URL handed out up to 12 hours ago by the client's clock plays without a request; an older one costs one audiobook request on Play, and only that path plays after an await.
- A save can never land in another account's listening position, and a deletion never races a final save.
- A takeover cannot adopt a session for an audiobook the listener can no longer play.

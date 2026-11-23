---
status: accepted
---

# Save listening positions natively by the web player's rules

[ADR 0029](0029-play-the-narration-track-in-the-android-app-with-a-native-media3-exoplayer.md) made the Android plugin the only writer of the listening position in the app, through a signed position URL, by the web player's rules including the CUP-71 retry ([#424](https://github.com/cup-audio/cup/issues/424), [#425](https://github.com/cup-audio/cup/issues/425)). The native code had to reproduce those rules, keep the position of a session that ended without the page, and decide when the signed URLs stop working. This was implemented in [cup-audio/cup#401](https://github.com/cup-audio/cup/pull/401) (spec [#392](https://github.com/cup-audio/cup/issues/392), Linear CUP-41, ticket [#434](https://github.com/cup-audio/cup/issues/434)). These decisions were recorded from code comments on 2026-11-23.

## Decision

### Mirror the web player in plain Java

- [`PositionSaves`](../../apps/mobile-app/android/app/src/main/java/audio/cup/app/PositionSaves.java) follows the web player's `PlaybackSession` in `playback-session.ts`, and [`ListeningPositions`](../../apps/mobile-app/android/app/src/main/java/audio/cup/app/ListeningPositions.java) its `listeningPositionAt` and `findUnitIndexAt` (`playback-session.ts`, `audiobook-timeline.ts`): the unit playing at a position is the last one that starts at or before it, or the first unit for a position before every start. A boundary belongs to the unit that starts there.
- Both, and [`EndedSession`](../../apps/mobile-app/android/app/src/main/java/audio/cup/app/EndedSession.java) and [`SignedUrlExpiry`](../../apps/mobile-app/android/app/src/main/java/audio/cup/app/SignedUrlExpiry.java), are plain Java so JVM unit tests cover them. `PositionSaves` takes its platform services (the write, the clock and the timer) behind an interface: the plugin uses Android's, the tests their own. The JVM tests [`ListeningPositionsTest`](../../apps/mobile-app/android/app/src/test/java/audio/cup/app/ListeningPositionsTest.java) and [`PositionSavesTest`](../../apps/mobile-app/android/app/src/test/java/audio/cup/app/PositionSavesTest.java) mirror the web player's cases in `audiobook-timeline.test.ts` and `playback-session.test.ts`.
- The saves' status is the page's `NativePositionSave`.

### The save rules

- `PositionSaves` must be used on one thread, which also receives the write callbacks. Saves are written in order through the signed position URL; only the latest request's failure arms a retry, and only the latest save that failed for a reason that can pass is saved again, after the retry delay or when the connection may be back, unless a newer save comes first. A newer save that is queued already carries a later position, and its outcome counts.
- Every `4xx` answer but `401` and `429` refuses the save for good, as the web player reads every client error but too many requests, such as an audiobook that is gone or no longer this account's; saving again would be refused too. An expired position URL (`401`) is retried instead: the page's next renewal replaces it, and the next writes, retries included, use the new URL.
- During playback, newer saves replace the retry every few seconds, so a first failure stays quiet, as in the web player, until saves have failed for as long as the retry delay or a retry failed too. The page then tells the listener. A refusal, or a failure the page tells, stays until a save succeeds, as on the web.
- The engine saves when the listener stops hearing playback, so a change to paused saves only when playback was heard at the last change, and it starts or stops the interval saves during playback. Every seek saves: the page's seeks and skips, the notification's buttons and seek bar, and the return to the start at the end, also seeks before the first Play, while ExoPlayer is idle. Before another audiobook replaces the loaded one, the previous one's position is saved before the pause that ends its playback.
- The connection may be back when the device has a network again (a default network callback, which is why the manifest asks for `ACCESS_NETWORK_STATE`) or Cup returned to the foreground; a failed save is then retried.

### Writing through the position URL

- [`PositionUrlWriter`](../../apps/mobile-app/android/app/src/main/java/audio/cup/app/PositionUrlWriter.java) sends saves off the main thread on one thread, so they leave in the order `PositionSaves` sends them, and answers on the handler's thread. The position URL carries its own authorization, so a save needs no session of the listener's, works while the page is suspended, and still authorizes the final save after the listener's session is gone. The request sets the header the position route's browser-mutation check requires, since it sends no `Origin`.

### The ended session

- When the engine ends a session without the page, it keeps the session's saves as an `EndedSession`, so the last position is not lost while the page lives: the native stop tries one final save, and if that fails too, the page's cached audiobook shows the position, and the page's next close with a save, or its load of another audiobook, tries once more. Nothing retries in between, and nothing saves once the last save succeeded or was refused, or the URLs expired. Stopping retries still writes the saves queued so far, such as a final save.

### When signed URLs stop working

- A loaded audiobook's track and position URLs come from the same audiobook response and expire together. The server's signed URLs stay valid at least until two days after the start of the UTC day they were issued on. `issuedAt` is when the page received the response, in epoch milliseconds by the device's clock, which the page's clock shares.
- The server refused the signed track URL itself, so only a newly signed one plays, when the media route answers `401` (an expired or invalid token) or `403` (a valid token whose grant expired or was revoked).

## Consequences

- The web player's and the native saves' rules must change together; the mirrored JVM tests are the check.
- A listener whose final native save fails keeps that position only while the page lives; once the URLs expire nothing saves it.

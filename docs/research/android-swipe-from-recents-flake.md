# Flaky swipe from recents in the Android playback test

> Historical research, incorporated 2026-11-25. It is the evidence for the stop order in `MediaPlaybackService` and the repeated swipe in `removeFromRecents()` that [cup-audio/cup#534](https://github.com/cup-audio/cup/pull/534) introduced. [ADR 0068](../adr/0068-drive-android-system-ui-and-the-webview-the-way-a-listener-does.md) records the swipe decision.

Research dates: 2026-11-24 to 2026-11-25, on the suite's emulator (AVD `cup-mobile-e2e-api36-ram4g`, `system-images;android-36;google_apis;arm64-v8a`, Android Emulator 37.3.10, Media3 1.11.1), against `main` at `28c81ccf`.

## Question

The Android E2E test "a playing session survives a swipe from recents and keeps saving, reopening Cup takes it over, and a swipe while paused ends it" failed intermittently and blocked deploys. Does the swipe fail to remove Cup's task, or does Cup keep its service and notification after a paused task is removed?

## Answer

Both happen, independently.

### The launcher keeps the card after the swipe

- **Symptom:** `Timed out after 10000 ms waiting for Cup's task to leave the recent apps.` This failed 2 of 8 full runs of `playback.test.ts`: once on the playing session's swipe and once on the call test's swipe. Each time, the screenshot showed Cup's card back in the middle of the recent apps.
- **The swipe is a fling.** The helper swiped in 200 ms from the card's center to the top of the screen (`input swipe`). A zero-velocity drag along the same path (`input motionevent`, held 300 ms before the release) was kept in 5 of 5 tries. So the launcher dismisses that drag only on its release velocity.
- **The fling is lost when `input` pauses before the release.** The input dispatcher's recent events (`dumpsys input`, `RecentQueue`) give every injected event's time.
  - On a freshly booted emulator, in 9 of 10 swipes the verdict followed the gap between the last move and the release. Every removed swipe released within 39 ms; four of the five kept ones released 54 to 126 ms after the last move.
  - The one kept swipe that released 15 ms after its last move had a 50 ms gap just before that, and stays unexplained.
  - In the suite, the kept swipe released 76 ms after its last move at y=346, while the removed ones released 21 to 22 ms after reaching y≈50 to 100.
  - A swipe with a 100 ms pause before the release was kept in 5 of 5 tries.
  - Android's `VelocityTracker` takes a pointer as stopped when the release comes more than 40 ms after the last move, which fits the split.
- **The launcher handles the touch either way.** Its log shows `TaskViewTouchControllerDeprecated: Handling touch.` for kept and removed swipes alike. Only a removed swipe goes on to `finishRecentsAnimation` and `onTaskRemoved`.
- **A drag without a fling works only from a narrow start.** Zero-velocity drags to y=0, started at a fraction of the card's height:

  | Start | Kept                                                                           |
  | ----- | ------------------------------------------------------------------------------ |
  | 70%   | 5 of 5                                                                         |
  | 80%   | 5 of 5                                                                         |
  | 85%   | 8 of 10                                                                        |
  | 90%   | 0 of 30, 20 of them with four busy loops on the emulator's CPU                 |
  | 95%   | 1 of 10                                                                        |
  | 98%   | 1 of 5 in the harness; in the suite the launcher did not take the touch at all |

  With the same harness, the old swipe was kept 6 of 30 times.

- **The dispatcher keeps only the last 10 events,** so a 200 ms swipe's DOWN often falls out of the queue before it is read.

### Media3 posts the notification again while the service stops

- **Symptom:** after the swipe while paused, the service and the media session are gone, but `dumpsys notification` still lists Cup's notification `id=1001`, without `FOREGROUND_SERVICE`. It failed 3 of 10 isolated runs of the test that ran with a background `dumpsys` sampler, and 0 of 6 without one. The process stays alive, and the notification stays until it is cancelled.
- **The stray post's time matches `session.release()`.** The leftover record's `mUpdateTimeMs` is the millisecond at which `MediaSessionImpl` logged its release in `MediaPlaybackService.onDestroy`.
- **The call sequence, logged with stack traces in a temporary build:**
  1. `onTaskRemoved` → `PlaybackEngine.stopNatively` → `MediaPlaybackService.stop` → Media3's `pauseAllPlayersAndStopSelf()` → `disableUserEngagedTimeout()`. This asks for a notification update while the session is still added, with `startInForegroundRequired=false`, so Media3 calls `NotificationManager.notify()` and detaches the notification from the foreground service.
  2. About 7 ms later, `onDestroy` → `session.release()`. The notification controller disconnects, and an update with the session no longer added calls Media3's `removeNotification()`.

  The app-side sequence was the same in passing and failing runs. In the failing runs, the notification assistant (`AiAiEcho`) was processing notifications during this window, and NotificationManagerService's removal events arrived about 200 ms later than in a passing run. That fits a held `notify()` that landed after the cancel.

- **With the session removed before the stop, the extra post is gone.** In the logs of three runs, the only update while the service stops comes from `removeSession` releasing the notification controller, with the session no longer added, and it removes the notification.

## Implications

- `MediaPlaybackService` removes its session from Media3 before it pauses the player and stops itself. Media3's `pauseAllPlayersAndStopSelf()` pauses only the players of added sessions, so the service pauses the player itself.
- `removeFromRecents()` keeps the fling and repeats it, up to three swipes in all. It repeats only when the task stayed and the dispatcher's recent events show the swipe delivered: the release at the swipe's end, preceded only by moves on its path, back to the DOWN at its start when that is still queued.
- With both changes, the whole `playback.test.ts` passed 10 times in a row, and `pnpm test:e2e:mobile:android --force` passed twice, 27 of 27 tests each.

## Limits

- One emulator image on one Mac, an Apple Silicon machine with other work running. The load varied, and from about 21:30 to 00:50 the emulator often did not finish booting within the suite's 180 seconds, so those runs say nothing about the test.
- The emulator logs `incompatible snapshot version` for the Quick Boot snapshot saved before Android Emulator 37.3.10, so every boot in this research was a cold boot.
- The timing of NotificationManagerService's held post is inferred from its listeners' events and the record's update time, not from its own logs.
- The kept swipe with a 15 ms release gap is unexplained.

## Reproduction

The [evidence archive](./android-swipe-from-recents-flake.tar.xz) contains:

- `harness/`: `harness.ts <variant> <count> <busy loops> <out dir>`. It boots the suite's AVD through `bootEmulator`, opens Settings, swipes its card out of the recent apps `count` times, and saves `dumpsys input` after each swipe. Set `CUP_CHECKOUT` to a checkout. `gaps.mjs` and `analyze-swipes.mjs` print each swipe's last-move-to-release gap.
- `harness-swipes/`: the recent events and gaps of the 10 baseline swipes quoted above.
- `suite-kept-swipe/`: the suite's kept swipe from 2026-11-24 14:25, as a launcher log excerpt and screenshot, plus the three swipes of a later run with their verdicts.
- `orphan-notification/`: a failing run's notification records before and after the swipe, the sampler's service and notification counts, and log excerpts of a failing run and a passing run with the temporary stack-trace logging.
- `after-fix/`: log excerpts of three runs with the fix, and the results of the 10 `playback.test.ts` runs and the two full Android runs.

The suite's kept swipe, from the input dispatcher; the times are milliseconds since the first listed event:

```text
  0 DOWN y=1193
  8 MOVE y=1145.3
 21 MOVE y=1067.7
 56 MOVE y=859
 79 MOVE y=721.8
 91 MOVE y=650.2
130 MOVE y=417.5
142 MOVE y=346
218 UP   y=0
```

---
status: accepted
---

# Retry failed listening-position saves quietly during playback

A listening session saves the listening position every few seconds during playback. Since CUP-71 a failed save is saved again unless a newer save comes first ([ADR 0029](0029-play-the-narration-track-in-the-android-app-with-a-native-media3-exoplayer.md), [playback architecture](../architecture/playback.md#listening-positions)), and [ADR 0034](0034-model-the-player-host-and-position-saves-as-xstate-machines.md) made the cadence a machine with `writer`, `retry` and `lifecycle` regions, in which a failure counts only when no newer save is queued behind it. How loudly a failure is reported, and which failures are retried at all, was decided in [cup-audio/cup#460](https://github.com/cup-audio/cup/pull/460), which wrote the [position saves machine](../../apps/web-app/src/app/player/position-saves-machine.ts). These decisions were recorded from code comments on 2026-11-23.

## Decision

- **Stay quiet while newer saves keep coming.** During playback, newer saves replace the retry every few seconds; they stay quiet until saves have failed for as long as the retry delay.
- **Report a failure once a retry failed too.** The listener is shown that saves fail once a failed save's retry failed too; the session keeps trying. On Android the [native-backed player](../../apps/web-app/src/app/player/native-track-player.ts) keeps a failure that can pass quiet until the plugin reports that saves still fail.
- **Do not retry a lasting refusal.** A lasting refusal, such as for a signed-out listener, is shown and not retried: saving again would be refused too.
- **Drop retries after closing.** A retry queued before the session closed, such as for a track being deleted, has no use and is dropped. Saves asked for before closing are still written, but nothing is retried or reported any more.

## Consequences

- A brief loss of connection during playback shows the listener nothing, because the next periodic save replaces the failed one.
- The Android plugin follows the same rules for its native saves (`PlaybackSession.getSaveFailure`), so both players report save failures alike.

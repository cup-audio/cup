---
status: accepted
---

# Show waiting for data to the system's media controls as paused

The player host reports the loaded audiobook to the system's media controls (the lock screen, the notification, media keys, headsets and earbuds) through a media session port. Browsers and iOS's WebView use `navigator.mediaSession`; the Android app's native player reports through its own Media3 session ([ADR 0029](0029-play-the-narration-track-in-the-android-app-with-a-native-media3-exoplayer.md)). The system extrapolates the position while the session says it plays. [cup-audio/cup#401](https://github.com/cup-audio/cup/pull/401) (issue [cup-audio/cup#392](https://github.com/cup-audio/cup/issues/392), CUP-41, CUP-71) introduced the port. These decisions were recorded from code comments on 2026-11-23.

## Decision

- The [media session port](../../apps/web-app/src/platform/media-session.ts) has a playback state for an element that plays but waits for data, between `waiting` and `playing`; the system must not move the position forward meanwhile.
- The [web implementation](../../apps/web-app/src/platform/media-session.web.ts) reports that state as paused, because the system moves the position forward only in the playing state; this keeps the shown position from running ahead of the audio.
- To remove the position state, the web implementation calls `setPositionState` without a state, which is how `navigator.mediaSession` clears it.

## Consequences

- During buffering, the lock screen and notification show the audiobook as paused rather than playing.

---
status: accepted
---

# Shorten app timings and set tolerances in the mobile E2E tests

Several shell behaviours only show after minutes (Media3's foreground grace, signed URL expiry, access token expiry), and the device's position and telemetry reports arrive with delays that depend on the Mac's load, especially when the deploy gate runs Android and iOS in parallel ([ADR 0026](0026-replay-mobile-e2e-passes-per-platform-and-run-both-platforms-in-parallel.md)). The tests may not retry, so they shorten what they can through debug-build launch arguments and wait with explicit tolerances. The playback timings landed with the native Android media player in [cup-audio/cup#401](https://github.com/cup-audio/cup/pull/401) ([cup-audio/cup#392](https://github.com/cup-audio/cup/issues/392), [ADR 0029](0029-play-the-narration-track-in-the-android-app-with-a-native-media3-exoplayer.md)); the save interval limit under load in [cup-audio/cup#455](https://github.com/cup-audio/cup/pull/455); the JS error wait with Sentry in [cup-audio/cup#422](https://github.com/cup-audio/cup/pull/422); the foreground refresh check in [cup-audio/cup#256](https://github.com/cup-audio/cup/pull/256) ([CUP-44](https://linear.app/cup-audio/issue/CUP-44)); the access token lifetime in [cup-audio/cup#312](https://github.com/cup-audio/cup/pull/312). These decisions were recorded from code comments on 2026-11-23.

## Decision

Android playback ([playback test](../../qa/mobile-e2e/test/android/playback.test.ts), [Android app device](../../qa/mobile-e2e/src/android/android-app-device.ts)):

- **Media3's foreground grace after a pause is 10 seconds instead of 10 minutes**, passed as the debug build's `foregroundGraceSeconds` launch argument.
- **The test Worker's signed URL lifetime is shortened to 30 seconds**, long enough for the time between the page's last fetch of the audiobook and Play. The native player is told the same lifetime through `signedUrlLifetimeSeconds`, which must be the test Worker's.
- **Only the server's URLs expire early**: the plugin keeps its 24 hours, so the Worker's refusal of a seek past the buffer, which requests the track again with the expired URL, ends the session.
- **The track is served at 32,000 bytes per second**, twice the narration track's 128 kbit/s, so ExoPlayer keeps loading while it plays.
- **Tolerances:** ExoPlayer's position may move up to 100 ms after a seek in the MP3 track, a few frames of 26 ms; the page's position, which follows ExoPlayer's reports, may lag behind or run ahead by up to 2.5 s; during the locked listen, two saves may be up to 7 s apart, against the plugin's 5-second save interval. The plugin checks twice a second whether a save is due, so the saves come every 5 to 5.5 s on an idle Mac; under load, such as the deploy gate's parallel iOS suite, they came every 5.7 to 6.3 s (2026-11-17). A seek bar drag in the media controls lands only roughly where it aims, since System UI's bar has margins.
- **A skip back is compared with the pause save only loosely**: ExoPlayer reports the pause before its playback thread stops the audio, and under load its position then moves on by a few hundred milliseconds without an event. So the back skip lands at or after the pause save, and a second forward skip lands where the first did.
- **The close test plays a track of several minutes**: opening the notification shade and finding Close can take over 10 s on a Mac under load, the default 19 s track ended before that, and the engine returned it to the start, so the page kept 0.
- **The Play/Pause button's labels are recorded in the page**, since a flicker lasts a few milliseconds, which polling misses.
- **Losing the connection restarts the test Worker**: `adb reverse --remove` refuses new connections only, and restarting the Worker ends the ones the plugin and ExoPlayer hold, the track's response and idle keep-alive connections alike.
- **The locked listen shows the unfrozen process, not network access**: loopback is exempt from Android's background network cut, so a test against a local Worker cannot show that the process keeps network access itself.
- ExoPlayer plays on under the emulator's `-no-audio`. With speech, it pauses for a duck request instead of lowering its volume. During a call it still wants to play, so the service stays in the foreground, and only the listener's pause ends a swiped session. Media3 brings the service back to the foreground before ExoPlayer plays, and the foreground service keeps Android's cached apps freezer away from Cup.
- Skipping before the first Play loads the audiobook into the plugin, which prepares nothing but saves the position; the test checks that no media session exists yet.

Telemetry ([telemetry assertions](../../qa/mobile-e2e/src/telemetry-assertions.ts)):

- **The shell's JS error is thrown again until one arrives with the account ID.** Right after a launch, the user rule has not loaded the account ID yet, and an error thrown then carries the user `signed-out`. Each attempt has its own message, because Sentry drops an error that repeats the one before it.
- **A test reads the account ID only after a request with the app's bearer token reached the Worker**, since Recents can show before it.
- **Crash events are counted once per event ID**: a native SDK can send a crash once while the process ends and again from disk on the next launch, and Sentry drops the second.
- **A shell whose crash reports are off is checked for native sends with a JS error as the signal**: the error goes through the plugin queue after the native SDK would have started, so its arrival tells that the relaunched Cup reports again, and a 5-second grace after it covers a native send still in flight.

Sign-in ([sign-in test](../../qa/mobile-e2e/test/sign-in.test.ts)):

- **The fake auth provider issues access tokens for 2 seconds**, so a test outlives an access token. supabase-js refreshes before every request once a token expires within 90 seconds, so any lifetime below that behaves alike. One second is too short: `exp` counts whole seconds, so a token issued late in a second could expire before the Worker checks it.
- Coming to the foreground refreshes at once, sooner than the 30-second refresh tick would, and the test waits up to 10 seconds for it.

Shared journeys ([journeys](../../qa/mobile-e2e/src/journeys.ts)):

- **A narration document link is scrolled into view before the tap, and the journey waits two animation frames**: any scroll closes the link's popover, and the scroll event has fired by the second frame.

## Consequences

- The debug build's playback timings differ from a release build's; release timings are not exercised by the suite.
- A Mac slow enough to exceed these tolerances fails the tests rather than retrying them.

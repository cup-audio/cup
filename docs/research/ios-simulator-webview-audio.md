# WebView audio on the iOS simulator

Research date: 2026-11-14, for [How does Cup's WebView audio behave on the iOS simulator?](https://github.com/patricktree/cup/issues/374) of the [native apps map](https://github.com/patricktree/cup/issues/371). Observed on a simulator the [mobile E2E suite](../../qa/mobile-e2e/README.md) created (device type iPhone 17, iOS 27.2 runtime `24B8117`) with Xcode 27.2 (`27B52`) on macOS 27.2 (`26B123`), Apple M4 Max, running the suite's debug build of the iOS shell (Capacitor 8.5.3) from commit `08b3d00d` against the suite's local test Worker and fake auth provider, so nothing reached production and no real account signed in. The WebView reports the frozen user agent `iPhone OS 18_7`. A throwaway change made the test Worker's fake speech 60 seconds per segment, which gave a 3:48 narration track (228.768 s, 3,660,288 bytes, a 440 Hz tone in four segments), and a 256 × 256 cover image. Inspection used Appium's WebKit remote debugging into Cup's WebView, the test Worker's request log, `xcrun simctl io screenshot` and the simulator's unified log. No physical device took part.

## Question

On the mobile E2E suite's iOS simulator, how does Cup's WebView `<audio>` playing a narration track behave in the respects a simulator can show: Now Playing on the lock screen and in Control Center with WebKit's defaults; whether `navigator.mediaSession` action handlers and `setPositionState` change what Now Playing shows; whether the signed track URL's range requests from `capacitor://localhost` return `206` through a whole listen, including after a seek near the end; and what happens to playback and to `CapacitorHttp` requests when the simulator locks or Cup goes to the background?

## Answer

- **WebKit publishes Now Playing for Cup without native code.** WebKit's GPU process registered the now-playing item as `com.apple.WebKit.GPU/audio.cup.app … Cup` with the title from `navigator.mediaSession.metadata`, the duration (228.768 s), the elapsed time, the playback rate and the 256 × 256 artwork, which it converted to TIFF; artist and album were empty. The lock screen showed the title, a position scrubber with elapsed and remaining time (`3:25`, `-0:24`), Rewind 10 seconds, Play or Pause, Fast-forward 10 seconds and the playback destination button, but a grey placeholder instead of the artwork. There are no next or previous track buttons.
- **The defaults drive the element directly.** With only the metadata set, as Cup ships, lock-screen Pause and Play paused and resumed the `<audio>` element without the page calling `pause()` or `play()`, and Fast-forward and Rewind arrived as MediaRemote `SkipForward` and `SkipBackward` commands with a 10-second interval and moved the element by 10 seconds. Scrubbing with the defaults was not exercised: the one attempt missed the scrubber.
- **Action handlers and position state take effect.** With handlers for `play`, `pause`, `seekto`, `seekforward` and `seekbackward` registered, lock-screen Pause and Play called the `pause` and `play` handlers, Fast-forward and Rewind called `seekforward` and `seekbackward` with `seekOffset` 10, and dragging the scrubber called `seekto` with the target `seekTime` and `fastSeek` false. The buttons stayed the same: still 10-second skips. `setPositionState({ duration: 3600, position: 1800, playbackRate: 1 })` made the lock screen show `30:00 of 1:00:00` for a 3:48 track, so position state replaces what WebKit reads from the element; once Cup sets it, Cup must keep it current. Removing the handlers and calling `setPositionState()` without arguments returned to the element's own position.
- **Range requests return `206` from `capacitor://localhost`.** WebKit requested `bytes=0-1` and then `bytes=0-3660287` of the signed track URL, both answered `206 Partial Content`, without an Origin header. Over the unthrottled loopback that one response held the whole track, so neither a whole listen nor a seek near the end made another request. Through a proxy throttled to 64 KiB/s in front of the test Worker, a seek to 8 seconds before the end, past the 32.8 seconds buffered, closed the first connection and requested `bytes=3522560-3660287`, then `bytes=3657728-3660287` and the gap `bytes=655360-3522559`, all `206`, and the track played to its end. Through 24 KiB/s with the simulator locked, the single `0-3660287` response streamed for about 147 seconds while locked and the track played to its end. The token in the URL does not depend on the host or port.
- **Locked, everything kept running.** Locked while playing, audio continued to the end of the track (about 4 minutes locked in the longest run), `document.visibilityState` was `hidden`, a 5-second page timer kept firing about every 6 seconds, a `fetch` through `CapacitorHttp` on each tick succeeded, and Cup's own listening-position saves (`PUT /api/audiobooks/{id}/position`, `204`) kept arriving about every 5 seconds. Lock-screen controls worked throughout. Sent to the background with the Home button and playback paused, the timer and the `CapacitorHttp` requests also kept running for the whole 75 seconds.
- **The simulator ignores the suspension a device would apply.** About 26 to 31 seconds after each lock, RunningBoard calculated Cup's app process as `running-suspended (role: None)`, and its WebKit WebContent and Networking processes as `running-suspended` as well, while the GPU process stayed `running-active (role: NonUserInteractive)`. For the app process it logged `Ignoring suspend because this process is simulated and has background audio capabilities`. The WebContent and Networking processes kept running as well, so the simulator enforces none of these states. Remote control commands from the lock screen briefly made Cup's app process active again through mediaremoted's `Sending remote control command … host process: audio.cup.app` assertions.

## Implications

- Lock-screen title, duration, position and play, pause and 10-second skips work with WebKit's defaults on iOS; the spec does not need native code for them. Handlers are needed only to route the commands through Cup's player, and position state only if Cup wants Now Playing to show something other than the element's own timeline.
- If the spec adds handlers and position state, it must update position state on every play, pause, seek and rate change, because the lock screen shows a stale value otherwise.
- The suspension states RunningBoard calculated are the prediction for a device: about 30 seconds after locking, only the GPU process, which plays the audio, may keep running. If a device enforces them, page JavaScript (and with it position saves), `CapacitorHttp` requests through the app process, and media loads through the Networking process past the buffered part of a long track all stop while audio continues. The simulator cannot confirm or refute this.
- The mobile E2E suite can cover the lock-screen Now Playing item and its controls through the accessibility tree (`UIA.MediaControls.NowPlaying.*`, `TrackPosition` with values such as `1:25 of 3:48`), but not background suspension, network suspension or Control Center.

## For the physical-iPad ticket

[Does Cup keep playing and saving the listening position through a long locked listen on a physical iPad?](https://github.com/patricktree/cup/issues/375) needs to check on the device what the simulator could not show:

- Whether audio continues through a locked listen of a track of at least 60 minutes over the real network, past the part buffered before locking, which depends on the Networking process staying awake.
- Whether listening-position saves (`PUT …/position`) keep reaching the server while locked, and from when they stop if they do; a `log stream` on the iPad with the predicate `process == "runningboardd" AND eventMessage CONTAINS "audio.cup.app"` shows the real states of Cup's processes.
- Whether the lock-screen artwork appears; the simulator showed a grey placeholder although MediaRemote received the artwork.
- The Control Center Now Playing module, which the simulator's Control Center does not show.
- Scrubbing on the lock screen with WebKit's defaults, and the duration and position staying correct after it.
- Headphones disconnecting, a call, and another app starting playback.
- The `UIBackgroundModes` `audio` variant: on the simulator that capability is what made RunningBoard ignore the suspension, so its effect on a device is open.

## Limits

- One simulator, one runtime and a 3:48 track; no physical device, so RunningBoard suspension, real network conditions, audio routing and interruptions were not observed. The simulator does not suspend Cup, so every "kept running" above holds for the simulator only.
- The test Worker served the track over the loopback at `http://localhost`, where the first response carried the whole file. The throttled runs put a Node TCP proxy in front of it and pointed Cup's element at the proxy's port, so they covered WebKit's range requests, not Cup's own track URL choice.
- In `xcrun simctl io` screenshots, the lock screen's transport buttons and sometimes the times were not drawn, although the accessibility tree listed them and taps on them worked; the dimmed screenshots show the lock screen before it woke. The Now Playing label read `Not Playing, <title>` in the accessibility tree even while playing.
- While locked, Appium's WebKit remote debugging sometimes listed no context for Cup's WebView, so some page logs were read after unlocking. Safari Web Inspector was not used.
- The tone is synthetic, and the 256 × 256 cover and 60-second segments were throwaway changes to the test Worker.

## Reproduction

The [probe archive](./ios-simulator-webview-audio.tar.xz) contains the throwaway test Worker diff, `zz-probe.test.ts`, a spec for `qa/mobile-e2e/test/ios/` that uses the suite's fixture to create the simulator, start the test Worker and sign in, then runs JavaScript command files dropped into a folder against the Appium session, the commands in the order used, `p.mjs`, which drops one command and waits for its result, the page and proxy log of the locked throttled listen, the simulator log excerpt (RunningBoard states, WebKit's MediaRemote calls and mediaremoted's now-playing items) and lock-screen screenshots. Its `README.txt` lists the steps.

The lock-screen Now Playing item with WebKit's defaults, from the accessibility tree:

```text
UIA.MediaControls.NowPlaying.LabelView   Not Playing, A deterministic document about careful testing
TrackPosition                            1:25 of 3:48
UIA.MediaControls.NowPlaying.LeftButton  Rewind 10 seconds
UIA.MediaControls.NowPlaying.CenterButton Pause
UIA.MediaControls.NowPlaying.RightButton Fast-forward 10 seconds
```

The page log with handlers registered, tapping Pause, Play, Fast-forward and Rewind on the lock screen, then dragging the scrubber; times are seconds since the probe started:

```text
365.0s hidden MS handler pause
369.6s hidden MS handler play
374.2s hidden MS handler seekforward offset=10
378.9s hidden MS handler seekbackward offset=10
428.1s hidden MS handler seekto {"seekTime":142.87413024902344,"fastSeek":false}
```

The seek near the end through the 64 KiB/s proxy, abridged; times are seconds since the proxy started:

```text
 9.1s GET narration-track.mp3 range=bytes=0-1               <- 206 bytes 0-1/3660288
 9.1s GET narration-track.mp3 range=bytes=0-3660287         <- 206 bytes 0-3660287/3660288
19.1s GET narration-track.mp3 range=bytes=3522560-3660287   <- 206 bytes 3522560-3660287/3660288
20.3s GET narration-track.mp3 range=bytes=3657728-3660287   <- 206 bytes 3657728-3660287/3660288
20.3s GET narration-track.mp3 range=bytes=655360-3522559    <- 206 bytes 655360-3522559/3660288
```

The locked listen through the 24 KiB/s proxy, abridged; the lock came 4 seconds after Play, `at` is the position and `buf` the buffered end in seconds, and `fetch` the `CapacitorHttp` request of each tick:

```text
 93.2s visible play() called at=0.0
 97.4s hidden  visibilitychange
100.3s hidden  tick#20 at=6.1   paused=false buf=12.2  fetch 200
172.4s hidden  tick#32 at=78.2  paused=false buf=122.8 fetch 200
244.3s hidden  tick#44 at=150.1 paused=false buf=228.8 fetch 200
316.4s hidden  tick#56 at=222.2 paused=false buf=228.8 fetch 200
323.0s hidden  audio:ended
```

RunningBoard during that listen (local time; the lock was at 15:49:59):

```text
15:50:27.169 WebKit.WebContent  running-suspended (role: None)
15:50:27.170 WebKit.GPU         running-active (role: NonUserInteractive)
15:50:30.333 WebKit.Networking  running-suspended (role: None)
15:50:30.340 audio.cup.app      Ignoring suspend because this process is simulated and has background audio capabilities
```

# Android mediaPlayback foreground service and WebView playback

> Historical research, incorporated 2026-11-17. It is the evidence that a `mediaPlayback` foreground service started on Play keeps Cup unfrozen and online in the background, on which [ADR 0029](../adr/0029-play-the-narration-track-in-the-android-app-with-a-native-media3-exoplayer.md) builds. Cup differs from the probe: the service holds a native Media3 ExoPlayer instead of keeping the WebView `<audio>` alive, because on the operator's Pixel the WebView suspended the hidden page and lost earbud commands ([#397](https://github.com/cup-audio/cup/issues/397)); its notification is Media3's media notification, and Cup declares no `POST_NOTIFICATIONS`. Built in [#401](https://github.com/cup-audio/cup/pull/401); the [playback architecture](../architecture/playback.md#androids-native-engine) has the current state. Repository observations below describe `08b3d00d`. [Original](https://github.com/cup-audio/cup/blob/247deef9d9bb2905b9c11807c4067c826d39a88f/docs/research/android-foreground-service-playback.md) on the unmerged branch `research/android-foreground-service-playback`.

Research date: 2026-11-14, for [Does a mediaPlayback foreground service keep Cup's WebView audio and network alive on the Android emulator?](https://github.com/cup-audio/cup/issues/373) in the [map for Android and iOS apps that play the narration track](https://github.com/cup-audio/cup/issues/371). Observed on the mobile E2E suite's emulator `cup-mobile-e2e-api36-ram4g` (Android 16, Google APIs system image `android-36` `arm64-v8a`, emulator 36.4.10.0, WebView Chrome 133.0.6943.137), the setup of the [Android background network access](android-background-network-access.md) research, which is the baseline without a foreground service. The debug build of the Android shell was built from commit `08b3d00d` with a throwaway stub plugin added to its debug source set; none of it was merged. The runs against production `https://cup.audio` sent only `GET /` to Cup and streamed one public-domain LibriVox MP3 from archive.org; the narration track check ran against the local [test Worker](../../qa/test-worker/README.md). No physical device took part.

## Question

On the emulator, does a `mediaPlayback` foreground service keep Cup's WebView `<audio>` playing and Cup's requests to `https://cup.audio` succeeding while Cup is in the background for at least 10 minutes? Does the narration track's signed URL serve range requests from the `https://localhost` page through a whole listen?

## Answer

- **The service keeps Cup alive in the background.** With the service started on Play while Cup was visible, Cup pressed to HOME and the screen turned off 60 seconds later, Cup's process and its WebView renderer stayed at process state 4 (foreground service) and `isFrozen=false` at every sample, every 30 seconds for 11 minutes, with the same process IDs throughout. Without the service, on the same setup, both went to state 15 (cached) and were frozen 90 seconds after HOME, as in the baseline.
- **Playback continues.** The LibriVox MP3 played on for the whole 11 minutes in the background, with the position advancing in step with the clock and JavaScript timers firing every 5 seconds without a gap. The WebView refilled its buffer three times while Cup was hidden with the screen off, from 414 to 676, 938 and 1133 seconds buffered. Without the service, the position stopped at 84 seconds when Android froze Cup, with 408 seconds buffered.
- **Requests to `cup.audio` succeed.** With the service, all 88 background requests to `https://cup.audio/`, 44 through `CapacitorHttp` and 44 through Cup's patched `fetch`, one pair every 15 seconds, answered `200`. Without the service, the first background request, 14 seconds after HOME, already failed with `Unable to resolve host "cup.audio": No address associated with hostname` (`UnknownHostException`) and `TypeError: Failed to fetch`, and so did every later one until Android froze Cup.
- **The renderer survives.** Cup's `sandboxed_process` renderer kept its process ID and the service's process state through every service run; it is bound to Cup's process and inherits its state, so it is frozen together with Cup without the service.
- **The signed track URL works from `https://localhost`.** Against the test Worker, signed in through the debug build's fake Google sign-in, the WebView's `<audio>` requested the 19-second, 309 KB fake narration track with `Range: bytes=0-` and got `206` with the whole file; a seek near the end and a replay were served from what it had loaded. A new element on the same signed URL, about 3.5 minutes later with Cup hidden and the screen off, got `206` again. A seek to 18.5 seconds on a new element, about 28 minutes after the URL was issued, made the WebView send `Range: bytes=262144-`, answered `206` with `Content-Range: bytes 262144-308735/308736`. The media requests carried no `Origin` header, so only the token authorized them, as the [signed media URL](../architecture/authentication.md#signed-media-url) intends. Loopback is exempt from the network cut, so this tests authorization only, not network access.

## Implications

- A `mediaPlayback` foreground service started on Play while Cup is visible is enough, on this emulator, to keep both the WebView's playback and Cup's network access alive in the background with the screen off: the service lifts Cup out of the cached state, so neither the [background network cut](android-background-network-access.md) nor the cached apps freezer applies. Listening-position saves through `CapacitorHttp` would keep working while Cup plays in the background, and the WebView keeps downloading a long track.
- The service needs no media session to do this; the stub posted only a minimal notification on its own channel. A real implementation still needs the media session for system controls, and decides what the notification shows; this probe says nothing about either.
- Once Cup stops playing, a hidden page that is not audible gets Chrome's intensive timer throttling: in the track check, with the service still running, page timers woke only about once a minute after some minutes hidden and silent. The service keeps the process unfrozen but does not exempt a silent page from throttling, so work scheduled with timers while paused in the background runs late.
- The narration track's signed URL needs no change for the Android shell's `https://localhost` origin: media requests carry no `Origin`, and range requests with an offset are authorized like the first.

## Limits

One emulator image and one Android version, on AC power; no physical device, so Doze, App Standby, OEM battery management, a real locked screen with a keyguard and the Pixel 10 Pro's Android 17 were not observed. The screen was turned off with the power key, which left the emulator's keyguard without a PIN. The service's notification channel had low importance and `POST_NOTIFICATIONS` was granted with `pm grant`; whether Cup must ask for it was not explored. The runs used a public-domain MP3, not a narration track, for the 11-minute listens; the narration track check used the test Worker's 19-second fake track over loopback, so a long track's many range requests and their timing over a real network were not observed. A first service run with the emulator's network throttled to 80 kbps after the stream started, as in the baseline, stalled at 409 seconds once the buffer ran out, and some `CapacitorHttp` requests failed with `unexpected end of stream`. The same service run without throttling, and shorter refill checks in the foreground, in the background and in the background with the screen off, each with and without a 150-second pause in the download, all refilled the buffer. So the stall is most likely an artifact of the emulator's throttling, but that was not proven.

## Reproduction

The [probe archive](./android-foreground-service-playback.tar.xz) contains the stub plugin's sources: `ProbeForegroundServicePlugin.java`, which starts and stops the service from JavaScript; `ProbeMediaPlaybackService.java`, which posts a minimal notification and calls `startForeground` with `FOREGROUND_SERVICE_TYPE_MEDIA_PLAYBACK`; the debug `AndroidManifest.xml` that declares it with `FOREGROUND_SERVICE`, `FOREGROUND_SERVICE_MEDIA_PLAYBACK` and `POST_NOTIFICATIONS`; and `DebugApplication.patch`, which registers the plugin. Copy them into `apps/mobile-app/android/app/src/debug` and build as the [mobile app README](../../apps/mobile-app/README.md#android-locally) describes. The archive's scripts reuse the baseline's `cdp-eval.mjs`:

- `run.sh <true|false> <out-dir> [full|80]`: one 11-minute background run against production, with or without the service; `fgs-probe.js` plays the MP3 after a tap and logs position, buffered end and requests to `cup.audio` every 5 and 15 seconds, and `monitor.sh` records process states, `isFrozen`, the service and the screen state every 30 seconds without touching the devtools socket.
- `refill.sh`: the shorter refill checks, which seek to 395 seconds so playback reaches the buffered end within 20 seconds.
- `track.sh` with `test-worker-servers.ts` and `track-probe.js`: the narration track check against the test Worker on a second emulator instance, with `cdp-network.mjs` recording the track's requests, their `Range` headers and responses, with tokens redacted.
- `results/`: the logs of the runs quoted here.

The service run without throttling, abridged; `at` is the position and `buffered` the buffered end, in seconds:

```text
  3s visible at=2   buffered=414 event:suspend
 16s hidden  at=14  buffered=414 visibilitychange
 30s app state=4 frozen=false  renderer state=4 frozen=false  fgs=1  Awake
 90s app state=4 frozen=false  renderer state=4 frozen=false  fgs=1  Asleep
142s hidden  at=140 buffered=676 event:suspend
404s hidden  at=402 buffered=938 event:suspend
615s hidden  at=613 buffered=938 fetch ok 200
662s app state=4 frozen=false  renderer state=4 frozen=false  fgs=1  Asleep
666s hidden  at=665 buffered=1133 event:suspend
680s visible at=678 buffered=1133 visibilitychange
```

The run without the service, abridged:

```text
 16s hidden  at=14  buffered=408 visibilitychange
 30s hidden  at=28  plugin ERR Unable to resolve host "cup.audio": No address associated with hostname
 30s hidden  at=28  fetch ERR TypeError: Failed to fetch
 60s app state=15 frozen=false  renderer state=15 frozen=false  fgs=0  Dozing
 85s hidden  at=83  buffered=408 tick
 90s app state=15 frozen=true   renderer state=15 frozen=true   fgs=0  Asleep
    … no tick for 595 s …
680s visible at=84  buffered=408 visibilitychange
680s visible at=84  plugin ok 200
```

The narration track's requests in the track check, abridged:

```text
   1.1s send GET …/narration-track.mp3?token=<redacted> range=bytes=0-     initiatorOrigin=https://localhost
   1.1s response 206 content-range=bytes 0-308735/308736
 208.3s send GET …/narration-track.mp3?token=<redacted> range=bytes=0-     (hidden, screen off)
 208.3s response 206 content-range=bytes 0-308735/308736
1693.0s send GET …/narration-track.mp3?token=<redacted>&probe=2&probe=2 range=bytes=262144-
1693.0s response 206 content-range=bytes 262144-308735/308736
```

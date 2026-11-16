# Playback

The web player plays an audiobook's [narration track](../GLOSSARY.md#narration-track), restores and saves the listener's listening position, and drives the system's media controls. In the Android app a native ExoPlayer plays the track instead, driven by the same player host. The [conversion](conversion.md#delivery-and-lifecycle) page describes how the track is joined from segments and served, and [authentication](authentication.md#signed-media-url) how its signed URL authorizes and renews.

## The web player

The web player plays the narration track with one `<audio>` element in browsers and the iOS app ([ADR 0011](../adr/0011-serve-one-narration-track-and-play-it-with-one-audio-element.md)). The [player host](../../apps/web-app/src/app/player/player-host.ts) reaches it only through the `Player` port: `PlayerHostServices.createPlayer` builds each loaded audiobook's player, which [`createPlatformPlayers`](../../apps/web-app/src/app/player/create-playback.ts) chooses once per platform. In browsers and iOS, every player plays on the same element, created once for the app shell's lifetime, and sets the loaded audiobook's track URL as its `src`; the signed URL carries the authorization, and the content security policy allows media only from the API origin's `/api/files/`.

- **State:** the element and its events are the player state; there is no player state machine.
- **Timeline:** the response's start offsets map `currentTime` to the current unit, which drives the reader's highlight; seeking sets `currentTime` and nothing swaps sources. A seek waits until the element reports a duration above 0, because WebKit's GStreamer media backend on Linux first reports 0, and a seek then can end playback at once; the next media event that finds the duration known applies it.
- **Play:** `play()` is called synchronously within the user gesture, because Mobile Safari refuses audio started after an await. A stale or failed track URL is [renewed](authentication.md#signed-media-url) first.

The [app E2E suite](../../qa/e2e/test-e2e/conversion.test.ts) plays a served track in Chromium and WebKit.

## The player host

The web application holds one player for every page inside its [app shell](../../apps/web-app/src/routes/_shell.tsx), so playback continues while the listener moves between pages. Recents controls the loaded audiobook through the [mini player](../../apps/web-app/src/app/components/mini-player.tsx) above its [tab bar](../../apps/web-app/src/app/components/account-tab-bar.tsx), and every detail view controls the audiobook it shows through the [player sheet](../../apps/web-app/src/app/components/player-sheet.tsx), which is disabled until that audiobook has a narration track. The player host holds at most one loaded audiobook; [`player-host.test.ts`](../../apps/web-app/src/app/player/player-host.test.ts) holds these rules:

- **Loading:** an audiobook loads only when the listener plays it, taps a segment, or seeks or skips in the sheet, not when its detail view opens. Loading replaces another loaded audiobook and saves that one's position.
- **Before loading:** a detail view shows the listener's listening position in the sheet and highlights its segment, without creating a player; while the account is being restored it shows the start.
- **Unloading:** the loaded audiobook keeps playing until the listener plays another, and is unloaded on leaving the shell, a change of the signed-in user, the track's deletion, or when renewing its URL finds the track gone. A reload restores it only from Android's native session ([adoption](#androids-native-engine)).
- **Track:** a loaded narration track never changes, because it exists only once every segment has audio; only its signed URL is [renewed](authentication.md#signed-media-url).

## Listening positions

Each signed-in listener has one saved position per conversion, a synchronization unit and an offset within its audio, which the server replaces on every save; anonymous positions stay on the device. Loading restores it; a loaded player is never moved by query refreshes or other devices' saves, so device switches resume from the last successful save. Saves are serialized to keep their order, and the request layer refuses a save for a user who is no longer signed in. The web application's [`PlaybackSession`](../../apps/web-app/src/app/player/playback-session.ts) converts between a listening position and a position on the track and orders the saves ([`playback-session.test.ts`](../../apps/web-app/src/app/player/playback-session.test.ts)); the browser's player sets the save cadence. The Android app's native player saves nothing from the page; see [Android's native engine](#androids-native-engine).

A failed save is saved again unless a newer save comes first, because since [Android 15](https://developer.android.com/about/versions/15/behavior-changes-all#background-network-access) the Android app's requests fail with `Unable to resolve host` from a few seconds after it leaves the foreground until it returns, even while it plays ([CUP-71](https://linear.app/cup-audio/issue/CUP-71), [research](../research/android-background-network-access.md)). The rule stays for the browser's player, where a save can fail until the app or tab returns:

- **When:** after a delay, when the device goes online, or when the app returns to the foreground.
- **What the listener sees:** nothing for a failure that can pass, such as a lost connection or a server error, until a retry fails too or saves have failed for as long as the retry delay; the player then says in plain words that the position is not saved yet, until a save succeeds. A lasting refusal, such as a signed-out listener, shows at once and is not saved again.
- **Gap:** saving again stops when the audiobook is unloaded, so a final save that fails on unloading is lost.

## System media controls

The player host drives the system's media controls in browsers and iOS itself through the [media session port](../../apps/web-app/src/platform/media-session.ts), whose implementation sits over `navigator.mediaSession`. On Android the port does nothing: the native player's own Media3 session reports to the system ([ADR 0029](../adr/0029-play-the-narration-track-in-the-android-app-with-a-native-media3-exoplayer.md)). The host publishes the loaded audiobook's title and cover image on load and clears the metadata, position state and action handlers whenever it closes the loaded player: on unload, `release`, a track found gone, and loading another audiobook.

- **Actions:** `play` and `pause` go through the host's own Play and Pause, so Play renews a stale track URL first and Pause saves the position; `stop` pauses and keeps the audiobook loaded; `seekto` seeks; `seekbackward` and `seekforward` skip by the interval the system sends, or 15 s without one. There is no `previoustrack` or `nexttrack`, because there is no queue.
- **State:** the playback state is `playing` or `paused` while an audiobook is loaded and `none` otherwise. The position state reports the narration track's listed duration, the timeline's total of the settled durations, rather than `element.duration`; the position including a pending seek, clamped to that duration; and the element's playback rate.
- **When:** the host reports on load and on every playback change its player announces, which for the element are `play`, `pause`, `seeked`, `ratechange`, `waiting`, `playing` and `ended`, never `timeupdate`; the system extrapolates the position in between. Each playback report also says whether the player waits for data and whether it has just ended. While it waits, the browser implementation reports `paused`, so the shown position does not run ahead of the audio.

[`player-host.test.ts`](../../apps/web-app/src/app/player/player-host.test.ts) covers these rules through the browser's `Player` on a fake audio element and a fake media session port, and [`media-session.web.test.ts`](../../apps/web-app/src/platform/media-session.web.test.ts) covers the browser implementation.

## In the mobile apps

iOS plays through the web player in its WebView, best effort, with WebKit's Now Playing, which the map [patricktree/cup#386](https://github.com/patricktree/cup/issues/386) takes up. The operator checked lock-screen playback of the web player on an iPhone and an Android phone in production ([patricktree/cup#72](https://github.com/patricktree/cup/issues/72)), before Android's network cut and freezer were found.

### Android's native engine

The Android app plays the narration track with a Media3 ExoPlayer in its own Capacitor plugin, inside a `mediaPlayback` media session service, and the page creates no `<audio>` ([ADR 0029](../adr/0029-play-the-narration-track-in-the-android-app-with-a-native-media3-exoplayer.md); the [mobile app guide](../../apps/mobile-app/README.md#playback) describes the plugin). ExoPlayer is the only playback state there:

- **The seam:** on Android, `createPlayer` builds the [native-backed player](../../apps/web-app/src/app/player/native-track-player.ts), which requires a signed-in listener. Loading sends `load`, which sets the media item unprepared, so nothing is fetched or shown; commands go to the plugin, and another audiobook's `load` replaces the item in the running session. Unloading, on sign-out, a user change or deletion, closes the session and stops the service.
- **State:** the plugin sends one `state` event after every change of ExoPlayer, and the page also asks for it on becoming visible, since a suspended page can miss events. Between events the page extrapolates a playing position; a command shows its effect at once.
- **System controls:** the notification, lock screen, media keys and earbuds act on ExoPlayer through its session, with back 15 s, play/pause and forward 15 s; a stop from a car or watch pauses. The first Play starts the service in the foreground, which keeps Cup unfrozen with the screen locked or in another app; after a pause it keeps Media3's foreground grace and then its notification.
- **Interruptions:** ExoPlayer handles audio focus with speech attributes, so a call or a navigation prompt pauses Cup and resumes it, and another app's media pauses it for good; it pauses when headphones disconnect, and nothing resumes it on reconnect.
- **Errors:** when ExoPlayer gives up loading the track, the plugin pauses and the page says to press Play, which prepares the track again at the same position. Only the page renews URLs, on its own Plays: one older than 12 hours, as in the browser, goes to the plugin with `replaceUrls`.
- **Native stops:** the service also stops when Cup is swiped from recents while paused (Media3's default; a playing session plays on), the media controls are dismissed after the grace, a paused session's URLs pass `urlsIssuedAt` plus 24 hours, or the server refuses the track URL (`401` or `403`, not retried). The plugin then drops its item and reports `closed` with the reason and the last position. The page keeps the audiobook loaded there, and its next Play renews expired URLs, then sends `load` and `play`.
- **Adoption:** the ExoPlayer lives as long as the process, so a page that starts while it plays, after a reload, a crash, a live update or a relaunch, fetches the plugin's audiobook and loads it without `load`, and playback goes on; a deleted audiobook or another account's session is closed instead. The first Play renews the adopted URLs.
- **Plan:** native listening-position saves through the [signed position URL](authentication.md#signed-position-url) ([#434](https://github.com/patricktree/cup/issues/434)); until then the Android app saves no position.

[`native-track-player.test.ts`](../../apps/web-app/src/app/player/native-track-player.test.ts) covers the native-backed player, native stops and adoption against a fake plugin, JUnit tests cover URL expiry, and the [mobile E2E suite](../../qa/mobile-e2e/README.md#playback-android) checks the session, system controls, a locked listen, audio focus, failures and the lifecycle on the emulator.

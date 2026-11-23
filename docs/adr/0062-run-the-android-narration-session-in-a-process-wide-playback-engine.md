---
status: accepted
---

# Run the Android narration session in a process-wide playback engine

[ADR 0029](0029-play-the-narration-track-in-the-android-app-with-a-native-media3-exoplayer.md) made a native Media3 ExoPlayer the narration track's engine on Android, held in a `MediaSessionService` and driven by the page through the player port. Building it raised a set of smaller decisions about how the engine, its service and its media session behave around Android's and Media3's own rules: who owns the player, when a session ends without the page, how paused URLs expire, which state changes the page hears about, and how the notification's buttons map onto session commands. They were implemented with the native Android media player in [cup-audio/cup#401](https://github.com/cup-audio/cup/pull/401) (spec [#392](https://github.com/cup-audio/cup/issues/392), Linear CUP-41), and the unreported load in [cup-audio/cup#464](https://github.com/cup-audio/cup/pull/464). These decisions were recorded from code comments on 2026-11-23.

## Decision

### One engine for the process

- The [playback engine](../../apps/mobile-app/android/app/src/main/java/audio/cup/app/PlaybackEngine.java) holds one Media3 ExoPlayer for the whole process, so a session outlives the activity and its WebView, and a page that starts while it plays takes it over. The [plugin](../../apps/mobile-app/android/app/src/main/java/audio/cup/app/MediaPlaybackPlugin.java) drives it for the page; the system's media controls reach it through the [service](../../apps/mobile-app/android/app/src/main/java/audio/cup/app/MediaPlaybackService.java)'s session. The engine must be used on the main thread.
- The engine outlives the plugin's activity, so a relaunched Cup's page reaches the same session. A playing session outlives the activity; only the page or a native stop ends it. The engine forwards states to the plugin of the current page, one at a time.
- `PlaybackEngine.Loaded.saves` is set right after construction rather than in the constructor, since its reports name the loaded audiobook.

### What the page hears

- After every change of the player but those of `load`, and after a native stop, the plugin sends one `state` event. The page asks for `getState` whenever it becomes visible, since events sent while the WebView suspends the hidden page can be lost, and when it starts, to take over a session that outlived the previous page.
- `load` sets the audiobook as the media item, paused, and prepares nothing: while the player was never prepared it fetches nothing and shows no notification; in a running session it replaces the item. The engine does not report a load until the player shows more than the load (`unreportedLoadPosition`), because the page shows that audiobook paused there already and receives the load's reports only after its next command: a Play on an audiobook that was not loaded would show Pause, then the load's paused state, then Play's own report. Every command of the page ends the unreported load, since its effect needs reporting; so does anything beyond the load, such as Play or a seek from the notification ([#464](https://github.com/cup-audio/cup/pull/464)).
- While a native stop is on its way, the states until then report nothing.
- The engine's `ClosedReason` is the page's `NativeClosedReason`, and `PositionOnClose` the page's `PositionOnClose`. The closed reasons are: `taskRemoved`, the listener swiped Cup from recents while paused; `notificationDismissed`, the listener swiped the notification away after the service left the foreground; `closed`, the listener pressed Close on the notification or the lock screen; `trackUrlExpired`, the URLs expired while paused or the server refused the track URL; `serviceStopped`, Android stopped the service for another reason.

### Loading, playing and seeking

- Every media item carries the app's name as its artist: without one, System UI on Android 17 shows "null" under the title.
- Loading another audiobook leaves it paused, as on the web. Loading the ended audiobook again starts from where the page holds it, which Play saves.
- The first Play starts the service; Play after a failed load prepares the item again and continues where it stopped. The playback error flag is set when the last load failed and ExoPlayer paused, and is cleared once ExoPlayer has no error, whoever prepared it: the page's Play, or the media session, which prepares an idle player itself for Play from the notification, a media key or a headset.
- A finished audiobook starts over the next time, as in Cup's player: the engine seeks to the start and pauses, both of which report themselves. Seeks to the end stop short of the track's end, as Cup's player seeks.
- A playing session checks every 500 ms whether a save is due, like a media element's time updates.
- Paused for a transient loss of audio focus, such as a call, ExoPlayer still wants to play; only its playback suppression reason says it is silent.
- `MediaPlaybackPlugin` reads whole milliseconds itself, because JavaScript numbers arrive as integers, longs or doubles and `PluginCall.getDouble` reads no long, such as an epoch time.

### Signed URLs that stop working

- A paused session whose URLs expired ends natively. While the player is paused, the engine checks again when the URLs expire, by a delayed check, whose clock stops while the device sleeps, and by an inexact alarm, which Android delivers once the device is awake again, also to a frozen Cup, on the main thread ([`ExpiryAlarmReceiver`](../../apps/mobile-app/android/app/src/main/java/audio/cup/app/ExpiryAlarmReceiver.java)). The alarm is non-wakeup and inexact, so it needs no exact-alarm permission, and it is not set again for the same time, since the player's state changes often while paused. Every command and every Play checks again, and so does a Play from the media session after the URLs expired before a check caught it.
- ExoPlayer's default load-error policy retries a refused track request like any other failure, so playback would continue from the buffer and fail only minutes later. A refused URL never works again, so the engine's `TrackLoadErrorPolicy` stops retrying it and the engine ends the session. Only a newly signed URL plays, and only the page fetches one: the closed state tells the page, whose next Play renews the URLs. Only expired URLs need the page to act.

### Ending the session

- The page closes the session on sign-out or a change of the signed-in user, which saves the position one last time, or without saving when the loaded audiobook is deleted or a starting page cannot take the session over, since a save would race the deletion.
- A native stop happens outside the player's own callback, which must not release the player. It drops the media item, stops the service, which removes the notification, and reports the closed state with the last position.
- When the service stopped and the engine did not stop it, Android did, and the session is over all the same; the service has released the player already, so the engine does not.

### The service and its media session

- [`MediaPlaybackService`](../../apps/mobile-app/android/app/src/main/java/audio/cup/app/MediaPlaybackService.java) is the `mediaPlayback` foreground service that holds the media session around the engine's ExoPlayer, which keeps Cup unfrozen and its network reachable with the screen locked or in another app. The engine hands its player over before starting the service, which it does on the first Play, always after a tap in Cup's visible UI, since Android refuses to start services from the background. Starting and stopping it must run on the main thread; stopping returns whether the service took the player over, and if not the caller releases it.
- Lifecycle races: a service started but not created yet finds no player in `onCreate` and stops; destroying the service is asynchronous, so a Play before then starts a new one for its player; a service the system restarted after Cup's process died, or that was closed before it was created, has no player and stops.
- Media3 runs the service in the foreground while the player plays, and for its grace after a pause or the end, after which it leaves the foreground and keeps the notification. The grace is Media3's default and maximum, 10 minutes ([`PlaybackTimings`](../../apps/mobile-app/android/app/src/main/java/audio/cup/app/PlaybackTimings.java)).
- Swiping Cup from recents keeps a playing session, also while it buffers or a call pauses it, and ends every other one ([`TaskRemoval`](../../apps/mobile-app/android/app/src/main/java/audio/cup/app/TaskRemoval.java), plain Java so JVM unit tests cover it): a session the listener paused, that ended, or whose load failed, which pauses it, ends. Media3's default decides by the foreground instead, which a call ends and whose grace keeps a paused session, so the service runs the default only for a session that ends.
- The notification and lock screen show back 15 s, play/pause, forward 15 s and Close; Media3 adds play/pause. Close is a custom session command rather than stop, because the session player handles stop as pause for cars and watches. The service offers Media3's default session commands plus Close to every controller, among them System UI's; the player commands stay the builder's defaults, since the default result's would leave the session without play, pause and the skips.
- Swiping the notification away, possible only after the grace, arrives as stop, which the session player handles as pause, so the notification would come back; the service ends the session instead. Close ends it at any time.

## Consequences

- The engine, the service and the page share the session's rules, so a change to one of the rules above must be checked against the page's native-backed player and the mobile E2E suite's lifecycle cases.
- The Android 17 artist workaround and the `getDouble` workaround depend on platform and Capacitor behaviour and need rechecking when either changes.
- A paused session on a sleeping device may end some time after its URLs expired, when the inexact alarm is delivered.

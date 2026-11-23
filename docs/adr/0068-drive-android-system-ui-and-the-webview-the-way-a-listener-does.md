---
status: accepted
---

# Drive Android system UI and the WebView the way a listener does

The Android specs press Back, swipe Cup out of the recent apps, cancel Google's real add-account screen and crash Cup's WebView and process on the emulator, so Android's, Google Play services' and Chromedriver's behaviour shapes each step ([ADR 0018](0018-test-the-mobile-apps-with-appium-through-webdriverio-on-host-owned-emulators-and-simulators.md)). The add-account and Back steps landed with the suite in [cup-audio/cup#211](https://github.com/cup-audio/cup/pull/211); the cancellation without an error in [cup-audio/cup#230](https://github.com/cup-audio/cup/pull/230); the Add dialog's Back without a keyboard in [cup-audio/cup#293](https://github.com/cup-audio/cup/pull/293) ([cup-audio/cup#285](https://github.com/cup-audio/cup/issues/285)); the recent apps steps with the native Android media player in [cup-audio/cup#401](https://github.com/cup-audio/cup/pull/401) ([cup-audio/cup#392](https://github.com/cup-audio/cup/issues/392)); the crash steps with Sentry in [cup-audio/cup#422](https://github.com/cup-audio/cup/pull/422) ([cup-audio/cup#403](https://github.com/cup-audio/cup/issues/403)); the external links test with [cup-audio/cup#502](https://github.com/cup-audio/cup/pull/502). These decisions were recorded from code comments on 2026-11-23.

## Decision

Recent apps ([Android app device](../../qa/mobile-e2e/src/android/android-app-device.ts)):

- **`removeFromRecents` swipes Cup's task away in the recent apps screen**, which destroys its activity; Android then tells its running services through `onTaskRemoved`.
- **Cup's card is found by its snapshot.** The launcher shows the recent apps with Cup's card, the latest task, in the middle; its snapshot exists only there, unlike a "Cup" label in Cup's own screen.
- **The card is swiped once it has stopped moving**, since it slides into place first.

The keyboard and the media controls ([Android app device](../../qa/mobile-e2e/src/android/android-app-device.ts)):

- **`waitForKeyboard` reads the window manager's `mImeShowing`**, which stays true until the keyboard's closing animation ends. The input method's `mInputShown`, which `isKeyboardShown()` reads, turns false as soon as a close is requested, and it never turned true when a field lost focus before the keyboard had appeared: the keyboard then showed and closed over the next two seconds and took the next Back press (2026-11-10).
- **The media controls' progress is read from the notification shade**, such as `9 seconds of 19 seconds`: System UI's own reading of the session's position and duration, which `dumpsys media_session` does not print.
- **The media controls are hidden as a listener does since Android 13**, where they replace the media notification: a long press on the player, then "Hide". System UI then cancels the notification, which Media3 hears as its dismissal; it is offered only once the session's service left the foreground. The long press is an `input swipe` that stays in place, above the seek bar on the player's title.
- Under its title, Cup's media notification names Cup, since System UI shows a missing artist as "null".
- **`adb shell` arguments are quoted for the device's shell**, because `adb shell` joins its arguments into one command line for it, such as shared text with spaces, `&` or `#`.

Google's add-account screen ([add-account cancel test](../../qa/mobile-e2e/test/android/add-account-cancel.test.ts)):

- With no account on the device, Google's sign-in opens a screen of Google Play services.
- **The test waits for the add-account activity itself before pressing Back.** Google Play services first shows `GoogleSignInActivity`, which then starts the add-account flow on top of itself: a Back pressed before that start cancels only the trampoline, and the add-account screen opens anyway. The wait is a readiness step, not an assertion.
- **It then waits for a button of the rendered page, such as SKIP on "Sign in with ease".** The add-account screen shows "Checking info…" while it loads Google's sign-in page, and a Back pressed then can close only the activities beneath it and leave the screen in front.
- **A cancellation the listener chose is no failure**, so the dialog that started it shows no error, such as the plugin's raw "[16] Cancelled by user.".

The Back button ([Back button test](../../qa/mobile-e2e/test/android/back-button.test.ts)):

- The Add dialog focuses itself, not its URL field, so no on-screen keyboard opens; an open keyboard would take the first Back instead of Cup. The test asserts both.
- A mark set on `window` tells whether Back finished the activity: a finished activity takes its page with it, and so does the mark.

Links that leave Cup ([external links test](../../qa/mobile-e2e/test/android/external-links.test.ts)):

- `browserPackage` asks Android which app it opens a web link with, such as the emulator's Chrome, as Capacitor hands every link that leaves Cup's origin to Android.
- **Checked only by which app is in front**: Capacitor hands every navigation away from Cup's origin to Android, and the test Worker's hosts are unreachable from the system's browser.

Crashes ([telemetry test](../../qa/mobile-e2e/test/android/telemetry.test.ts)):

- **Each run hides Android's error dialogs on its emulator** ([emulator](../../qa/mobile-e2e/src/android/emulator.ts)). A second crash within a minute, as the telemetry tests cause, shows "Cup keeps stopping", and Android keeps the crashed process until someone answers it; without error dialogs it ends the process at once, which `waitForProcessExit()` waits for ([cup-audio/cup#456](https://github.com/cup-audio/cup/pull/456)).
- **Attaching to the WebView again after a relaunch or reopen.** A relaunch replaces the WebView's process, so the device attaches to it anew. Reopening Cup in a process that still runs, such as one a playing media session kept, creates a new WebView page in the same context and closes the one Chromedriver was attached to, so the device waits for the new page.
- **The renderer crash runs after the WebDriver script returns.** The debug build's hook loads `chrome://crash` from a timeout once the script has returned, so the answer does not wait on the dying page.
- **After a renderer crash, the test attaches to the recreated activity's WebView and waits for it.** It lives in the same process as the dead one, so Chromedriver keeps its session and stays on the dead page's closed window until it switches.
- **After a native crash, the test waits for Cup's process to exit before launching it again.** Sentry's crash handler sends the crash, or stores it, before Android ends the process; a launch that force-stopped Cup sooner would cut that short.

## Consequences

- A change to Google Play services' sign-in activities or Google's sign-in page fails the add-account test, which also needs internet access.
- A launcher that lays out the recent apps differently, or names the snapshot view differently, fails `removeFromRecents`.
- The external links tests cannot check which URL the browser opened.

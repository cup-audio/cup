# Mobile app

Capacitor shells for Android and iOS, based on Content Relay's `apps/mobile-app`. Both package Cup from the shared web app in `apps/web-app/dist/web`. Both use the identifier `audio.cup.app`; the iOS Share Extension uses `audio.cup.app.share`.

## Build

From the repository root:

```sh
pnpm --filter '@cup/mobile-app' build
```

This runs the cached shared web build and Capacitor configuration check, then syncs web assets into both native projects. Sync runs outside Turbo and always executes, even when both build tasks hit the cache.

The repository-wide `pnpm build` and every [validation gate](../../AGENTS.md#validation-gates) run `turbo:build` without syncing native projects. Use the mobile package's `build` command above before building or installing a native app.

To sync an already built web bundle:

```sh
pnpm --filter '@cup/mobile-app' native:sync
```

## Android locally

Install Android Studio with SDK platform 36 and Java 21. Set `JAVA_HOME` to a Java 21 installation; Android Studio on macOS includes one at `/Applications/Android Studio.app/Contents/jbr/Contents/Home`.

Start an Android emulator in Android Studio, or connect a device with USB debugging enabled, then deploy the debug build to it from the repository root:

```sh
pnpm --filter '@cup/mobile-app' android:run
```

The script builds the web bundle, syncs it into the Android project, installs the debug build, launches it, and fails if the app stops within five seconds of launching. It finds the SDK the way the [mobile E2E suite](../../qa/mobile-e2e/README.md#prerequisites) does, at `ANDROID_HOME`, then `ANDROID_SDK_ROOT`, then `~/Library/Android/sdk`, and passes it to Gradle, so no `local.properties` is needed. It deploys to the only device `adb devices` lists; with several connected, set `ANDROID_SERIAL` to the one to use. The debug build talks to `https://cup.audio`; confirm the landing page renders and the app can close and reopen without a crash.

After changing native Android code, also run its JVM unit tests and Android lint. The plugin's decision logic, such as when the signed URLs expire, lives in plain Java classes without Android imports, which JUnit 4 tests in `android/app/src/test/` cover on the JVM, without Robolectric. The package's `turbo:test` runs them with `./gradlew testDebugUnitTest` through [`scripts/test-jvm.mts`](scripts/test-jvm.mts), so the review gate runs them; it needs Java 21 and the Android SDK, which `pnpm --filter @cup/mobile-app jvm:check` checks. Set `ANDROID_HOME` when the SDK is not in Android Studio's default location:

```sh
pnpm --filter @cup/mobile-app test
cd apps/mobile-app/android
ANDROID_HOME="${ANDROID_HOME:-${HOME}/Library/Android/sdk}" ./gradlew lintDebug
```

The debug APK is written to `apps/mobile-app/android/app/build/outputs/apk/debug/app-debug.apk`.

The [mobile E2E tests](../../qa/mobile-e2e/README.md) launch the debug build on their own emulator against a local test Worker; [automated and manual checks](#automated-and-manual-checks) lists what they cover.

### Debug launch arguments

The debug build reads the backend origin from the intent extra `cupTestApiOrigin`, which the mobile E2E suite sets to its test Worker:

```sh
adb shell am start -n audio.cup.app/.MainActivity --es cupTestApiOrigin http://localhost:8787
```

The value must be exactly `http://localhost:<port>`; any other value stops the app at launch with an `IllegalArgumentException` naming the argument, so a broken test setup never reaches production. Without the extra, a debug build uses `https://cup.audio` as before. Use `adb reverse tcp:<port> tcp:<port>` to make a port on your Mac reachable at `localhost` on the device.

Only the debug source set (`android/app/src/debug`) handles the argument: before Capacitor loads the page, it sets the global `window.cupTestApiOrigin` that the web app's `apiOrigin()` reads, and lets the `https://localhost` page load `http://localhost` media. The same source set allows plain HTTP to `localhost` and nowhere else. The argument needs Android 10 (API 29) or later, where activity pre-creation callbacks exist. Release builds contain none of this.

With the test origin, the debug build also replaces the native Google sign-in plugin with a fake of the same name (`FakeGoogleSignInPlugin`, debug sources only). Its `signIn` asks the test Worker's fake auth provider, found as the `supabaseUrl` of the Worker's auth configuration, for an ID token carrying the hashed nonce it was given, so the web app's unchanged sign-in, Secure Storage and the Worker's token check run without Google. A debug build launched without the test origin keeps the real plugin and signs in with real Google.

The second launch argument, the boolean extra `cupTestRealGoogleSignIn`, keeps the real plugin under the test origin, so a test can open Google's real add-account screen:

```sh
adb shell am start -n audio.cup.app/.MainActivity --es cupTestApiOrigin http://localhost:8787 --ez cupTestRealGoogleSignIn true
```

It has no effect without `cupTestApiOrigin`.

The third launch argument, the string extra `cupTestSentryDsn`, makes the debug build report to Sentry, which it otherwise never does: the mobile E2E suite passes its Sentry stub's DSN. The value must be exactly `http://<key>@127.0.0.1:<port>/<project>` and needs `cupTestApiOrigin`, or the app stops at launch with an `IllegalArgumentException`. The debug sources set it as the global `window.cupTestSentryDsn` next to `window.cupTestApiOrigin`, and allow plain HTTP to `127.0.0.1`, where the native SDK sends:

```sh
adb shell am start -n audio.cup.app/.MainActivity --es cupTestApiOrigin http://localhost:8787 --es cupTestSentryDsn http://public@127.0.0.1:9000/2
```

JS events go through the test Worker's telemetry tunnel, which must allowlist the DSN in `SENTRY_TUNNEL_DSNS`; native events go straight to the DSN, so its port needs `adb reverse` too.

## iOS

After building, open `apps/mobile-app/ios/App/App.xcodeproj` in Xcode and choose a simulator or a device. The project uses Swift Package Manager, matching Content Relay. Both targets, `App` and `CupShare`, sign automatically with the Apple Developer team `4GQ2V3WJW8`, which owns both bundle identifiers; signing for a device or the App Store needs an Xcode account in that team.

The app's `Info.plist` names it Cup in both `CFBundleDisplayName`, shown under its icon, and `CFBundleName`, which iOS shows in system prompts such as the one before the sign-in sheet; the target and its product stay named `App`. It declares `ITSAppUsesNonExemptEncryption` as false, because Cup uses only the encryption iOS provides, such as HTTPS and the Keychain, so App Store Connect asks no export compliance question for an uploaded build.

The [mobile E2E tests](../../qa/mobile-e2e/README.md) launch the debug build on their own simulator against a local test Worker; [automated and manual checks](#automated-and-manual-checks) lists what they cover.

### iOS debug launch arguments

The debug build reads the backend origin from the process arguments `-cupTestApiOrigin <origin>`, which the mobile E2E suite sets to its test Worker:

```sh
xcrun simctl launch <simulator> audio.cup.app -cupTestApiOrigin http://localhost:8787
```

In Xcode, add the arguments under the App scheme's Run action, Arguments Passed On Launch. The arguments set the defaults key `cupTestApiOrigin` for one launch, and the build reads that key. A launch without arguments, such as one a shared URL starts, reads the key from the app's own defaults, which the E2E suite writes before such a launch and a reinstall erases:

```sh
xcrun simctl spawn <simulator> defaults write audio.cup.app cupTestApiOrigin http://localhost:8787
```

As on [Android](#debug-launch-arguments), the value must be exactly `http://localhost:<port>`; any other value stops the app at launch with a fatal error naming the key, and without the key a debug build uses `https://cup.audio`. The simulator shares the Mac's loopback, so `localhost` needs no port forwarding.

Only `#if DEBUG` code in [`MainViewController.swift`](ios/App/App/MainViewController.swift) handles the key: before Capacitor loads the page, it adds a document-start script that sets the global `window.cupTestApiOrigin`. App Transport Security's built-in exemption for `localhost` allows the plain HTTP, so `Info.plist` is unchanged. Release builds contain none of this.

As on Android, the second argument, `-cupTestSentryDsn <dsn>`, makes the debug build report to Sentry, which it otherwise never does: the mobile E2E suite passes its Sentry stub's DSN. The value must be exactly `http://<key>@127.0.0.1:<port>/<project>` and needs `cupTestApiOrigin`, or the app stops at launch with a fatal error. The same debug code sets it as the global `window.cupTestSentryDsn`. The simulator shares the Mac's loopback, so the native SDK reaches the stub on `127.0.0.1` without forwarding, and App Transport Security lets it send plain HTTP there:

```sh
xcrun simctl launch <simulator> audio.cup.app -cupTestApiOrigin http://localhost:8787 -cupTestSentryDsn http://public@127.0.0.1:9000/2
```

### iOS sign-in

The iOS app signs in with Google through Supabase's OAuth flow in an `ASWebAuthenticationSession`, a system browser sheet over Cup, not natively as on Android ([ADR 0019](../../docs/adr/0019-sign-in-on-ios-through-supabase-oauth-in-a-system-browser-sheet.md)). The app's own [`WebAuthenticationPlugin`](ios/App/App/WebAuthenticationPlugin.swift), registered in `MainViewController`, opens the authorization URL and returns the `audio.cup.app://auth/callback` URL the sheet ends at; the web app exchanges its code. Before the sheet opens, iOS asks whether Cup may use the auth provider's site to sign in. The plugin opens only HTTPS URLs; a debug build also opens `http://localhost`, the mobile E2E suite's fake auth provider. The Capacitor configuration leaves the Google sign-in plugin out of the iOS app.

## Safe area

Cup's WebView fills the whole screen on iOS, under the status bar and the notch. The web app declares `viewport-fit=cover`, so `env(safe-area-inset-*)` reports those areas, and the shell layout pads its content by them. A fixed backdrop in the page's background covers the status bar on every screen, so content scrolled up to it does not show through, and the sticky header extends its background up under the status bar.

## Links and sharing

The apps intentionally don't support trial links ([ADR 0017](../../docs/adr/0017-keep-trial-links-out-of-the-mobile-apps.md)). Neither app claims web links, so tapping a link to `cup.audio`, such as a trial link, opens the browser, and share intake ignores URLs on Cup's hostnames.

The Android app accepts shared plain text containing an HTTP or HTTPS URL, fills a conversion form with it and submits that form right away. A signed-in account gets the Add dialog over Recents (`/recent/add`), which starts the conversion and closes, so the new track appears on Recents. Signed out, the URL fills the landing page's start form, whose submission asks the listener to sign in and starts the conversion once they have. A share that arrives while a start is still pending or rate-limited waits until the form can submit again.

## Backend access and grant sessions

Mobile API requests use ordinary `fetch` calls patched by `CapacitorHttp` to use native networking. The backend origin is `https://cup.audio`, except in a debug build launched with a [test origin](#debug-launch-arguments). Browser requests continue using the browser's same-origin fetch.

The browser exchanges trial credentials for persistent Secure, HttpOnly cookies. The apps open no trials ([ADR 0017](../../docs/adr/0017-keep-trial-links-out-of-the-mobile-apps.md)), so their private account requests rely on the signed-in user's bearer token; Capacitor's native cookie manager still stores any server-issued cookies and sends them on later requests. The `CapacitorCookies` document.cookie patch (<https://capacitorjs.com/docs/apis/cookies>) is not enabled.

Native mutations omit Origin and must include the existing custom request header and JSON content type. Browser mutations must have a matching Origin; cross-site Fetch Metadata is rejected. No cross-origin browser CORS access is enabled. The mobile suite's [native networking test](../../qa/mobile-e2e/README.md#native-networking) checks the native mutation on both platforms.

Capacitor's native HTTP response headers can expose Set-Cookie to JavaScript, so HttpOnly does not provide the same isolation as browser networking.

## iOS Share Extension

The iOS app bundles `CupShare.appex`, displayed as **Cup** in Safari and Chrome's Share Sheets. Share a web page, a web URL or text containing an HTTP(S) URL and choose **Cup**: the extension reads the first HTTP(S) URL from the share, whether the sharing app hands it over as a URL, as a URL's data or as text, and opens the main app with it on its own, which starts converting the URL. Sharing takes no tap after **Cup**.

The handoff uses `audio.cup.app://share?url=<encoded-url>`, the app's only URL scheme. The URL fills and submits a conversion form as on [Android](#links-and-sharing), and Cup links are ignored there too; a URL still pending in memory is discarded when the app closes.

The app uses the UIScene lifecycle, which iOS 27 requires: an app built with the iOS 27 SDK that keeps the app-delegate lifecycle stops at launch. [`SceneDelegate`](ios/App/App/SceneDelegate.swift) receives incoming URLs, both at a cold start and while Cup runs, and hands them to Capacitor's `SceneDelegateProxy`, which passes them on to the App plugin's `appUrlOpen` event and launch URL.

The extension uses the same responder-chain URL-opening approach as Chromium, calling `openURL:options:completionHandler:` dynamically. Apple does not support this handoff from Share Extensions; test it after iOS updates. A failed handoff stays in the extension with an error, and its **Open in Cup** button retries it; **Cancel** closes the sheet, such as after a share that held no HTTP(S) URL. The extension does not start conversions or access session cookies.

The [mobile E2E tests](../../qa/mobile-e2e/README.md#share-intake-ios) cover what the app does with a share link once it arrives, and a share from Safari through the real Share Sheet and this extension on a simulator; sharing from Chrome and the handoff on a physical iPhone stay [manual](#automated-and-manual-checks).

Build the App scheme; it builds, signs, and embeds the extension. A developer outside the project's signing team passes their own `DEVELOPMENT_TEAM` to `xcodebuild` instead of changing the project. Both bundle identifiers need provisioning: `audio.cup.app` and `audio.cup.app.share`. If Cup is hidden in the Share Sheet, look under More in its app row.

## Sentry

The shells report to Sentry's `cup-app` project through the web app's `initializeTelemetry`, which starts `@sentry/capacitor` and with it the native SDK; the [observability page](../../docs/architecture/observability.md#what-the-shells-send) describes what they send. Native crashes are captured without a consent prompt and with no installation ID kept on the device ([ADR 0030](../../docs/adr/0030-capture-native-crashes-in-the-shells-without-consent-keeping-no-installation-id-on-the-device.md)).

On or off, by the rule of [`@cup/telemetry.browser`](../../libs/telemetry.browser/README.md): a release build sends only while its backend is `https://cup.audio`. A debug build, which the web app recognises by the `Capacitor.DEBUG` flag that Capacitor's native side sets, sends nothing unless it was launched with the `cupTestSentryDsn` argument ([Android](#debug-launch-arguments), [iOS](#ios-debug-launch-arguments)), and then only to that DSN. Both send as release `audio.cup.app@<version>+<build>` with `dist` the build number, read through `App.getInfo()`. After each release archive and before its store upload, `pnpm --filter '@cup/mobile-app' symbols:upload` uploads the iOS dSYMs and the source maps of the web bundle packed into the build; a failure blocks the store upload ([native release](../../docs/production-configuration.md#native-release)).

The mobile app declares `@sentry/capacitor`, and imports it in the Capacitor configuration like its other plugins, only so that `cap sync` adds its native plugin, on iOS through `ios.includePlugins`; the web app holds the Sentry code. The workspace's `pnpm patch` of `@sentry/capacitor` (`patches/`) forwards `enableAutoSessionTracking` to the native SDKs, which the plugin otherwise leaves at their defaults, and lets the JavaScript options carry Cocoa options (`cocoaOptions`) for the iOS shell.

### Android Sentry setup

- **No installation ID on the device.** [`InMemoryInstallation`](android/app/src/main/java/io/sentry/android/core/InMemoryInstallation.java), in Sentry's own package `io.sentry.android.core`, sets Sentry's package-private installation ID to a random value per process. `MainActivity.onCreate` calls it before `super.onCreate`, before the page can start the SDK, so the SDK never writes or reads its `INSTALLATION` file.
- **A pinned native core.** The helper depends on the exact version of `io.sentry:sentry-android-core`, which `variables.gradle` pins as `sentryAndroidVersion`. Every Gradle build fails when the pin differs from the `io.sentry:sentry-android` version that `@sentry/capacitor`'s native plugin declares. After a `@sentry/capacitor` update, move the pin, check that `Installation` still has `deviceId` and `staticLock`, and run the [mobile E2E telemetry test](../../qa/mobile-e2e/README.md#telemetry).
- **Manifest settings** in [`AndroidManifest.xml`](android/app/src/main/AndroidManifest.xml): no automatic init (the page starts the SDK), no session tracking and no scope persistence, and no NDK, because sentry-native stores an installation ID of its own. Native crashes arrive as tombstones, without the raw tombstone and without reports from before the first launch; ANRs with thread dumps and fingerprinting, without historical reports; the memory limiter on, without historical reports; no external storage context and no root check. Traces at 1.0 with activity tracing and frames tracking, without user-interaction tracing. No screenshots, view hierarchies, feedback, replay or profiling. `attachThreads` comes from the JS options.
- The Sentry SDK still creates its cache folder under `cache/sentry/`, with options, an outbox and an empty breadcrumb queue, but no file holding an ID.

### iOS Sentry setup

- **No installation ID on the device.** The Cocoa SDK reads its installation ID from the file `Library/Caches/INSTALLATION` and writes a new one there when it finds none. [`MainViewController`](ios/App/App/MainViewController.swift)'s initialiser, which runs before the page loads and so before the page starts the SDK, replaces whatever is at that path with an empty directory, so the SDK can neither read nor write the file and keeps a new ID per process. Cocoa sends the ID only as the user of an event without one, and the web app always sets a user. After a `@sentry/capacitor` update, run the [mobile E2E telemetry test](../../qa/mobile-e2e/README.md#telemetry), which reads the ID in two launches.
- **Cocoa options** from the JS options, through the patch's `cocoaOptions`: no session tracking and no watchdog termination tracking; traces at 1.0 with view-controller tracing and frames tracking, without network, file I/O, Core Data or user-interaction tracing; MetricKit without raw payloads; all threads attached; no SIGTERM reports and no C++ exception experiment; no screenshots or view hierarchies. App-hang tracking and network breadcrumbs keep Cocoa's defaults. Cocoa's crash handler reports uncaught NSExceptions on iOS; its `enableUncaughtNSExceptionReporting` option exists on macOS only. Feedback, replay and profiling stay off by default.
- **The debug flag.** With Capacitor as a Swift package, `Capacitor.DEBUG` is true only when `Info.plist`'s `CAPACITOR_DEBUG` is `true`. `Info.plist` takes it from the build setting of the same name, which [`debug.xcconfig`](ios/debug.xcconfig) sets for the Debug configuration only, so a release build reports `false`. The mobile E2E telemetry test fails if a debug build counted as a release build, since it would then send nothing to the stub.
- **Swift Package Manager.** `cap sync ios` adds the plugin's package to `CapApp-SPM/Package.swift`, with the path of the patched package in pnpm's store, and Xcode resolves `sentry-apple-binaries`, pinned in `Package.resolved`.
- **Privacy manifest.** The Sentry SDK's own manifest declares crash, performance and other diagnostic data, not linked to the user, for app functionality, and the required-reason APIs it uses. The app's [`PrivacyInfo.xcprivacy`](ios/App/App/PrivacyInfo.xcprivacy) declares the same three types as linked to the user, because Cup sends them with the account ID, and no tracking. The App Store privacy labels are the operator's to fill in at release.
- The SDK still keeps its cache under `Library/Caches/io.sentry/`, where a crash report waits until the next launch sends it.

### Crash reports switch

The account settings show a "Send crash reports" switch in the shells only, on by default, which turns native crash capture off; the shell's JS errors still reach Sentry. The [observability page](../../docs/architecture/observability.md#crash-reports-switch) describes what it covers.

- **The `CrashReporting` plugin**, Cup's own on both platforms like `AndroidShare` and `WebAuthentication`: [`CrashReportingPlugin.java`](android/app/src/main/java/audio/cup/app/CrashReportingPlugin.java), registered in `MainActivity`, and [`CrashReportingPlugin.swift`](ios/App/App/CrashReportingPlugin.swift), registered in `MainViewController`. `isEnabled()` resolves with `{ enabled }`; `setEnabled({ enabled })` stores it, in the SharedPreferences file `audio.cup.app.crash_reporting` on Android and under the UserDefaults key `cupCrashReportsEnabled` on iOS. The web app calls it through [`src/platform/crash-reporting.ts`](../web-app/src/platform/crash-reporting.ts).
- **On the next start.** `initializeTelemetry` reads the switch before `Sentry.init` and passes it as `enableNative`, so a start with the switch off runs Sentry JS-only. The native SDK already running keeps running until the app stops; nothing restarts Sentry.
- **Sentry's files.** `setEnabled({ enabled: false })` deletes them: `cache/sentry/` on Android; `io.sentry/`, `SentryCrash/` and `async.log` in `Library/Caches` on iOS, where the empty `INSTALLATION` directory stays. While the switch is off, `MainActivity.onCreate` and `MainViewController`'s initialiser delete them again, so what the earlier process's SDK wrote after the switch is gone too.
- **Privacy manifest.** The app's `PrivacyInfo.xcprivacy` declares the UserDefaults access, which the [WebView process loss](#webview-process-loss) record shares, with reason `CA92.1`: data only the app reads.

## WebView process loss

The WebView renders the page in a process of its own, the renderer on Android and the WebContent process on iOS, which can crash or which the system can kill to reclaim memory. Each shell brings the page back, records the loss natively, and the reloaded web app reports it once to Sentry as a JS event through the telemetry tunnel ([observability](../../docs/architecture/observability.md#what-the-shells-send)). The `WebViewProcessLoss` plugin's `takeLoss()` hands the web app the recorded loss and forgets it; `initializeTelemetry` takes it at every start in a shell, also when telemetry is off, so a loss is never reported in a later start. There is no restart notice and no automatic resume: playback stops, at the last saved listening position.

- **Android.** Without help, Android ends Cup's whole process with its renderer. `MainActivity` registers a Capacitor `WebViewListener` from [`WebViewProcessLoss`](android/app/src/main/java/audio/cup/app/WebViewProcessLoss.java), whose `onRenderProcessGone` records in Cup's own SharedPreferences whether the renderer crashed or the system killed it, its `rendererPriorityAtExit`, and whether the activity was started (foreground). It then removes the dead WebView from the view hierarchy, destroys it, recreates the activity and returns `true`, so Cup's process lives on and the web app reloads at its start URL, on Recents for a signed-in listener. The debug build's `CupTestRendererCrash` plugin, registered with a test API origin, loads `chrome://crash` in the WebView, so the [mobile E2E telemetry test](../../qa/mobile-e2e/README.md#telemetry) can crash the renderer.
- **iOS.** WebKit tells the WebView's navigation delegate, Capacitor's, which resets the bridge and reloads the page. [`MainViewController`](ios/App/App/MainViewController.swift) puts `WebContentTerminationObserver` in its place: on `webViewWebContentProcessDidTerminate` it records in Cup's own `UserDefaults` whether the app was in the background, and then calls Capacitor's handler. Every other delegate call reaches Capacitor's delegate through Objective-C message forwarding, so methods Capacitor adds later keep working. The privacy manifest declares the `UserDefaults` access with reason `CA92.1`.

### iOS WebContent check

The mobile E2E suite cannot end the WebContent process, so check the iOS side once by hand after a Capacitor update or a change to `MainViewController`, with a debug build in the simulator against a test Worker and a Sentry stub, as the [mobile E2E telemetry test](../../qa/mobile-e2e/README.md#telemetry) launches it:

1. Pause the app in Xcode's debugger and end the WebView's WebContent process through WebKit's private `_killWebContentProcess`: `expr -l objc -- (void)[[(id)[[[[UIApplication sharedApplication] windows] firstObject] rootViewController] webView] _killWebContentProcess]`.
2. Continue: the page reloads, Capacitor's log prints `WebView process terminated`, and a navigation afterwards still works, which shows that the observer forwards Capacitor's navigation calls.
3. The stub receives one `error` event with the fingerprint `webview-content-terminated` and the tag `cup.app.state` `foreground`, through the test Worker's `/_/e`.

## Automated and manual checks

The [mobile E2E tests](../../qa/mobile-e2e/README.md) run the debug build of each shell on an emulator or simulator against a local test Worker, in the [deploy gate](../../AGENTS.md#validation-gates). They cover:

- **Both platforms**: a cold start against the test Worker, signing in from the landing page and from the home page's sign-in link and seeing Recents loaded from the test Worker ([`test/sign-in.test.ts`](../../qa/mobile-e2e/test/sign-in.test.ts)).
- **Both platforms, signed in**: the session in Secure Storage across a relaunch after signing in and after signing out, its refresh after a return from the background, and native networking: bearer-token requests and an Origin-less mutation through `CapacitorHttp`.
- **Android, telemetry**: against the test's Sentry stub, a shell JS error arrives through the telemetry tunnel without client IP headers, a native crash arrives with the account ID as its user, two launches send different device IDs, and no installation ID file or sentry-native folder exists; a renderer crash brings Cup back on Recents in the same process, and its event arrives through the tunnel ([`test/android/telemetry.test.ts`](../../qa/mobile-e2e/test/android/telemetry.test.ts)).
- **iOS, telemetry**: against the test's Sentry stub, a shell JS error arrives through the telemetry tunnel without client IP headers, two native crashes arrive with the account ID as their user, two launches hold different installation IDs, and `Library/Caches/INSTALLATION` is an empty directory ([`test/ios/telemetry.test.ts`](../../qa/mobile-e2e/test/ios/telemetry.test.ts)).
- **Both platforms, crash reports switch**: turning "Send crash reports" off in the account settings and restarting leaves no Sentry files on the device, and a native crash then sends nothing while JS errors still arrive.
- **Android**: sign-in through the native adapter with a fake of the Google sign-in plugin, cancelling Google's real add-account screen, share intake through `ACTION_SEND` intents (signed in with Cup stopped or running, `&`, `+` and fragments, a URL inside text, and signed out), the back button, and [playback](#playback): no session before the first Play, then a foreground `mediaPlayback` service whose session shows the title, cover, whole duration and position; media keys and the notification's buttons and seek bar acting on the player, and its Close ending a playing session; a listen of about two minutes with the screen off and Cup unfrozen; a call and focus requests pausing and resuming it; failure paths: expired or refused track URLs ending the session, and a lost connection showing the playback error, reporting `ERROR` to the system and playing on after Play from the notification or the page; the lifecycle: a playing session surviving a swipe from recents and taken over on reopening, a swipe while paused, sign-out and hiding the media controls after the shortened grace ending it; and every case's saves arriving through the position URL, never from the page ([`test/android/playback.test.ts`](../../qa/mobile-e2e/test/android/playback.test.ts)).
- **iOS**: sign-in through the real `ASWebAuthenticationSession` against the fake auth provider, share links starting a conversion when signed in and filling the landing page's start form and asking to sign in when signed out, each with Cup started by the link or running, sharing from Safari through the Share Sheet and `CupShare`, which starts Cup and, signed in, the conversion with no tap after **Cup**, and the audiobook page's sticky header staying below the status bar, at rest and scrolled, and the status bar backdrop on Recents ([`test/ios/safe-area.test.ts`](../../qa/mobile-e2e/test/ios/safe-area.test.ts)).

The [iOS WebContent check](#ios-webcontent-check) stays a one-time manual check in the simulator.

What the web app does with a share, such as repeat shares, `cup.audio` links and malformed links or text, the component tests of the share plugins cover with a faked Capacitor bridge, as [`native-track-player.test.ts`](../web-app/src/app/player/native-track-player.test.ts) covers what the page sends the playback plugin and how it follows its state; the mobile tests keep one test per native channel and app state.

The rest stays manual on physical devices with release-signed builds, listed in [CUP-44](https://linear.app/cup-audio/issue/CUP-44/test-the-android-and-ios-apps-native-functionality-on-physical-devices):

1. Playback through a locked device, lock-screen, notification and headset controls, and audio focus: on iOS, with the narration track's signed URL from the shell's origin; on Android, what the emulator cannot show, such as earbuds, headphone disconnects, other apps taking focus and a long locked listen against production, was checked by hand on the operator's Pixel as CUP-41's acceptance check ([#435](https://github.com/patricktree/cup/issues/435)), with no checked-in protocol.
2. Release-signed builds: install and run, reach `https://cup.audio` through `CapacitorHttp`, and carry no debug override, cleartext exception or sign-in fake.
3. Real Google sign-in: the Android account picker with a real account, switching accounts after signing out, and on iOS Google's page in the sign-in sheet, which the tests replace with the fake auth provider's redirect.
4. Sharing from real apps: Cup in the Android Sharesheet, sharing from Safari and from Chrome on iOS, and the `CupShare` handoff on a physical iPhone after each iOS update, each starting the conversion signed in without a further tap, with Cup started by the share and running.
5. App shell: icons and splash screen, and a tapped `cup.audio` link opening the browser, not the app.
6. Navigation without loading flashes.

## Brand assets

Edit the canonical artwork in `tooling/brand-assets/assets/` at the repository root. Run `pnpm brand-assets:sync` to regenerate native icons, splash images, and web assets, then review the generated changes. Native sync uses the checked-in brand assets without regenerating them. See [the brand asset guide](../../tooling/brand-assets/README.md) for sources, sizing, and validation.

## Playback

iOS has no native audio player: it plays the narration track through the web player's one `<audio>` in its WebView and shows it through WebKit's own Now Playing; see [playback](../../docs/architecture/playback.md).

The Android app plays the narration track with a native Media3 ExoPlayer ([ADR 0029](../../docs/adr/0029-play-the-narration-track-in-the-android-app-with-a-native-media3-exoplayer.md)), because Android cuts a cached Cup's network about 5 to 7 seconds after it leaves the foreground and freezes it 60 to 90 seconds later ([research](../../docs/research/android-background-network-access.md)) and suspends a hidden page's JavaScript, and Android WebView has no Media Session API. The page creates no `<audio>` there and drives the player through the web app's [native-backed player](../web-app/src/app/player/native-track-player.ts); [playback](../../docs/architecture/playback.md#androids-native-engine) describes the seam. The plugin is app-local Java in `android/app/src/main/java/audio/cup/app/`, registered in `MainActivity` like `AndroidSharePlugin`:

- **`PlaybackEngine`** owns the ExoPlayer, one per process, so a session outlives the activity and its WebView and a new page can take it over. ExoPlayer handles audio focus with speech attributes, which pauses for a duck request instead of lowering the volume, and pauses when headphones disconnect. At the end it returns to the start, paused; when loading the track fails it pauses and reports a `playback` error, and the next `play` prepares the item again. The media session prepares the failed player itself for Play from the notification or a media key, and the engine drops the error once ExoPlayer has none.
- **`MediaPlaybackPlugin`** (`CupMediaPlayback`) is the page's side of the engine. It takes `load`, which sets the media item without preparing it, `play`, `pause`, `seekTo`, `skipBy`, `replaceUrls`, `close` and `getState`, and sends one `state` event after every change of the player and after a native stop. `load` and `replaceUrls` carry the signed URLs and `urlsIssuedAt`, when the page received them, as one [`SignedUrls`](android/app/src/main/java/audio/cup/app/SignedUrls.java); [`SignedUrlExpiry`](android/app/src/main/java/audio/cup/app/SignedUrlExpiry.java), plain Java, decides when they expire, and `ExpiryAlarmReceiver` receives the alarm for it.
- **`SessionPlayer`** wraps the ExoPlayer for the session: it offers no previous and next, and handles stop as pause, so car head units, Android Auto and Wear OS keep a stop that leaves the audiobook loaded.
- **`MediaPlaybackService`**, a Media3 `MediaSessionService`, holds the session around that player. Its notification and the lock screen show the title, cover, whole duration and position, with Cup as the artist because System UI shows a missing one as `null`, and back 15 s, play/pause, forward 15 s and Close, which ends the session like a native stop; there is no stop button, since stop from cars and watches pauses. Tapping the notification opens Cup. It releases the player when it stops.

The [playback architecture](../../docs/architecture/playback.md#androids-native-engine) holds the service's lifecycle, the native stops, adoption of a running session and the native listening-position saves, which `PlaybackEngine`, `MediaPlaybackService` and `PositionSaves` implement.

The manifest adds `ACCESS_NETWORK_STATE`, for the network callback that retries a failed save, `FOREGROUND_SERVICE`, `FOREGROUND_SERVICE_MEDIA_PLAYBACK` and the service with `foregroundServiceType="mediaPlayback"` and the `androidx.media3.session.MediaSessionService` intent filter, exported as Media3 documents so that system controllers can connect, and the unexported `ExpiryAlarmReceiver`, whose inexact alarm needs no exact-alarm permission; `media3-exoplayer` merges `WAKE_LOCK`. It declares no `POST_NOTIFICATIONS`, because media session notifications are exempt and Cup has no others, and no `MediaButtonReceiver` or playback resumption, so a media button after the service stopped does not start Cup. The dependencies are Media3's ExoPlayer and session libraries, at `androidxMedia3Version` in `variables.gradle`.

Debug builds add `FocusProbePlugin` (debug sources only), registered with the test origin like the sign-in fake. It takes audio focus from Cup on an adb broadcast, as a call (`transient`), a navigation prompt (`duck`) or another media app (`full`) would, and gives it back with `abandon`:

```sh
adb shell am broadcast -p audio.cup.app -a audio.cup.app.FOCUS_PROBE --es focus transient
```

With the test origin, debug builds also read two integer launch arguments into `PlaybackTimings` (`TestPlaybackTimings`, debug sources only): `cupTestSignedUrlLifetimeSeconds`, how long the plugin treats signed URLs as valid instead of 24 hours, and `cupTestForegroundGraceSeconds`, Media3's foreground grace instead of 10 minutes, set with `setForegroundServiceTimeoutMs`.

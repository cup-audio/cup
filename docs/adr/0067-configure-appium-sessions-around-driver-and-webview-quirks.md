---
status: accepted
---

# Configure Appium sessions around driver and WebView quirks

[ADR 0018](0018-test-the-mobile-apps-with-appium-through-webdriverio-on-host-owned-emulators-and-simulators.md) chose Appium through WebdriverIO, with the UiAutomator2 and XCUITest drivers pinned exactly. How the suite installs Appium's drivers and opens its sessions was shaped by how Appium, its drivers, Chromedriver, Vitest and Android's adbd behave on a developer's Mac. These choices landed with the suite in [cup-audio/cup#211](https://github.com/cup-audio/cup/pull/211) (spec [cup-audio/cup#199](https://github.com/cup-audio/cup/issues/199)); the driver installation lock came with the parallel platforms in [cup-audio/cup#255](https://github.com/cup-audio/cup/pull/255). These decisions were recorded from code comments on 2026-11-23.

## Decision

- **Drivers live in a package-local, git-ignored `APPIUM_HOME`** ([appium](../../qa/mobile-e2e/src/appium.ts)), `qa/mobile-e2e/.appium`, so `pnpm install` never installs drivers; the suite installs them on its first run unless the pinned version is already there.
- **Driver installation is serialized by a lock file** in `APPIUM_HOME`: the Android and iOS processes of a parallel run, and runs in other checkouts of the same folder, would otherwise write `APPIUM_HOME` at once.
- **The package's own Appium CLI runs under the suite's Node.js**, so that stopping the child process stops Appium. Its path is resolved with `createRequire`, since Vitest's module runner does not support `import.meta.resolve`.
- **Appium may download the Chromedriver that matches the emulator's WebView** (`--allow-insecure uiautomator2:chromedriver_autodownload` and `appium:chromedriverAutodownload`).
- **UiAutomator2's host ports are reserved like every other port**: it forwards `systemPort` and `chromedriverPort` to the device. The capabilities object is not a literal, because WebdriverIO's capability types lack some UiAutomator2 options.
- **Appium's logcat capture is off** (`appium:skipLogcatCapture`). It streams the whole log buffer, including the snapshot's boot log, the moment the session starts and then every new line. That stream made the emulator drop its adb connection now and then: "device offline" at session start, or a killed UiAutomator2 server mid-test. No test reads the capture; a failed test's device log is a one-off `logcat` dump of the buffer since the test started instead.
- **Listing contexts on Android reads `/proc/net/unix` only** (`appium:ensureWebviewsHavePages` and `appium:enableWebviewDetailsCollection` off, in the [Android app device](../../qa/mobile-e2e/src/android/android-app-device.ts)). By default, listing contexts sends an HTTP request through `adb forward` to the devtools socket of every app's WebView, Cup's or not. An app that Android's cached-apps freezer has frozen, such as the Google app in the background, never accepts those connections; once its socket's listen backlog is full, adbd blocks connecting to it and every later adb call on the emulator hangs. With these options off, Chromedriver attaches to Cup's WebView only.
- **iOS sessions run a prebuilt WebDriverAgent** (`appium:usePrebuiltWDA` with the derived data folder of the suite's own build, in the [iOS app device](../../qa/mobile-e2e/src/ios/ios-app-device.ts)), started with `test-without-building` and never built inside a session. Installing the XCUITest driver is what brings the WebDriverAgent sources the [global setup](../../qa/mobile-e2e/src/ios/global-setup.ts) builds.
- **WebDriverAgent's ports are reserved like every other port.** It listens on `wdaLocalPort` and `mjpegServerPort` of the host's loopback, which the suite reserves from the operating system before opening the session.
- **The iOS device attaches only to a context of a page Cup rendered, never to a blank WebView**: Appium hangs for minutes when asked to attach to one, so the device picks the latest context whose page is Cup's.
- **After an iOS launch, the device waits for rendered text in the WebView before attaching.** When WebKit's content process crashes at launch, the WebView stays at `about:blank`, and Appium hangs for minutes when asked to attach to it; waiting for rendered text also keeps Web Inspector away from a page still loading.

## Consequences

- Deleting `qa/mobile-e2e/.appium` makes the next run download and install the drivers again; a second checkout of the same folder waits for the lock instead of corrupting it.
- Appium's context listing on Android no longer sees other apps' WebViews; a test that needed one would have to turn the details collection back on and accept the adbd hang risk.
- A new XCUITest driver version needs a new WebDriverAgent build, which the first run after the update makes.

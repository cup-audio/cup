---
status: accepted
---

# Limit the shells' native Sentry SDKs to crash and app-start data

[ADR 0031](0031-capture-native-crashes-in-the-shells-without-consent-keeping-no-installation-id-on-the-device.md) decided that the Android and iOS shells capture native crashes for every listener without consent, keep Sentry's installation ID in memory only, and offer a "Send crash reports" switch. Implementing it meant configuring each native SDK option by option, deciding where the switch lives and which files it deletes, and declaring the data in iOS's privacy manifest. This was built in [cup-audio/cup#422](https://github.com/cup-audio/cup/pull/422) (tickets [#417](https://github.com/cup-audio/cup/issues/417), [#418](https://github.com/cup-audio/cup/issues/418) and [#419](https://github.com/cup-audio/cup/issues/419), from [#403](https://github.com/cup-audio/cup/issues/403)). These decisions were recorded from code comments on 2026-11-23; the mobile app README's Sentry section describes the setup.

## Decision

### Android SDK options

The [Android manifest](../../apps/mobile-app/android/app/src/main/AndroidManifest.xml) configures the native Sentry SDK, which the web app starts through `@sentry/capacitor` (`io.sentry.auto-init` is off), so that it keeps no identifier on the device:

- No release health (auto session tracking off), no scope written to disk (scope persistence off), and no sentry-native (NDK off), which stores its own installation ID.
- Native crashes arrive as Android's tombstones, from this launch on only: tombstones on, raw tombstones not attached, and no historical tombstones, ANRs or memory-limiter events.
- Tracing records activity spans with frames, which carry the app start, and no user-interaction spans.
- Nothing that can show what the listener sees or types (no screenshots, no view hierarchy, no shake-to-report feedback, no session replay), and no profiling.

### The installation ID

The mechanisms are ADR 0031's; their details:

- Android: [`InMemoryInstallation`](../../apps/mobile-app/android/app/src/main/java/io/sentry/android/core/InMemoryInstallation.java) gives the process a random installation ID of 32 hex digits, the format Sentry writes, unless it has one. With `deviceId` already set, Sentry's `Installation` never touches its `INSTALLATION` file. It must run before Sentry can start, from `MainActivity.onCreate` before `super.onCreate`, so before the bridge loads the page, whose JavaScript starts the SDK.
- iOS: the [main view controller](../../apps/mobile-app/ios/App/App/MainViewController.swift), which UIKit creates from `Main.storyboard` before the page loads and so before the web app starts the native SDK, puts a directory in the place of `Library/Caches/INSTALLATION`. The Cocoa SDK reads the ID from that file and writes a new random one when it finds none; with a directory there, reading and writing both fail, so the SDK keeps its new ID for this process only. Whatever is there is replaced, such as a file that an earlier build let the SDK write. If creating the directory fails, an ID the SDK writes lasts this launch only: the next launch removes it.

### The "Send crash reports" switch

- Both shells' `CrashReportingPlugin` ([Android](../../apps/mobile-app/android/app/src/main/java/audio/cup/app/CrashReportingPlugin.java), [iOS](../../apps/mobile-app/ios/App/App/CrashReportingPlugin.swift)) hold the switch, on by default, in Cup's own storage. The web app reads it before it starts Sentry and starts the native SDK only while it is on, so turning it off takes full effect on the next start. On Android it is written synchronously, so a crash right after the switch changed cannot lose it.
- Turning it off also deletes the native SDK's files, such as crash reports waiting to be sent, and every start with the switch off deletes what a native SDK left. The SDK of the process in which the listener turned the switch off keeps running, and can write again, until the app stops.
- The Android SDK keeps everything in its cache folder `cache/sentry/`: options, the outbox and crash reports waiting to be sent. With the NDK off and the installation ID in memory, it writes nowhere else, so that folder is what the switch deletes.
- The Cocoa SDK keeps its files in `Library/Caches`: envelopes and the scope in `io.sentry/`, crash reports in `SentryCrash/`, and the log of its crash handler in `async.log`; the switch deletes those. The `INSTALLATION` directory stays: it holds nothing, and `SentryInstallationFile` needs it.

### iOS privacy manifest

- [`PrivacyInfo.xcprivacy`](../../apps/mobile-app/ios/App/App/PrivacyInfo.xcprivacy) is Cup's own privacy manifest, which Xcode's privacy report merges with those of the frameworks the app bundles. The Sentry SDK's manifest declares crash, performance and other diagnostic data as not linked to the user; Cup sends them with the listener's account ID, so Cup's manifest declares them linked. Neither Cup nor Sentry tracks.
- Its user-defaults API reason covers data only Cup reads and writes, such as the "Send crash reports" switch.

## Consequences

- Release health, session replay, profiling and user-interaction traces are unavailable for the shells.
- Turning crash reports off does not stop the running SDK; a listener who wants nothing sent must restart the app.
- A Sentry SDK update must be checked against the option names in the manifest and the file locations the switch deletes.

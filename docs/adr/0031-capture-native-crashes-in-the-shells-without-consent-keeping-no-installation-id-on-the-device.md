---
status: accepted
---

# Capture native crashes in the shells without consent, keeping no installation ID on the device

Sentry's native SDKs in the Android and iOS shells capture native crashes, ANRs and app hangs, which no JS error handler sees. Both SDKs store an installation ID on the device and send it with every event, a telemetry-only identifier that would track a listener across launches. [Does client telemetry need consent or a privacy policy change, and must data stay in the EU?](https://github.com/patricktree/cup/issues/341), [Do the shells keep native crash capture, given both native SDKs store an installation ID on the device?](https://github.com/patricktree/cup/issues/369) and [How do EU apps run native crash reporting, and can Cup's shells run it without explicit consent?](https://github.com/patricktree/cup/issues/370) ([research](../research/native-crash-consent.md)) settled with the operator on 2026-11-14 whether and how the shells keep native capture. [Do the shells' native Sentry SDKs, configured as decided, write and send no installation ID?](https://github.com/patricktree/cup/issues/377) proved the setup in a probe. Tickets [#417](https://github.com/patricktree/cup/issues/417) and [#418](https://github.com/patricktree/cup/issues/418) built it for Android and iOS, in pull request [#422](https://github.com/patricktree/cup/pull/422).

## Decision

- **Native capture runs for every listener, with no consent prompt.** The legal judgement, which is not legal advice: telemetry is strictly necessary to keep the service stable, and minimised, since it stores no telemetry-only identifier and drops the IP address and any location finer than the country. By EDPB Guidelines 2/2023 the SDKs' device reads and their crash cache are still in scope of the ePrivacy rules, so the privacy policy states this reasoning and a lawyer checks it before launch.
- **The installation ID lives in memory only,** a new random one per process, through four workarounds the probe found necessary:
  1. Android: a helper in Sentry's package `io.sentry.android.core`, called from `MainActivity.onCreate` before the page can start the SDK, sets the package-private `Installation.deviceId` under `Installation.staticLock`, so the SDK never writes or reads its `INSTALLATION` file. The build pins `sentry-android-core` and fails when it differs from the version `@sentry/capacitor` brings.
  2. Android: sentry-native writes a second ID file of its own, so the NDK is off, and the app leaves its modules `sentry-android-ndk` and `sentry-native-ndk` out of the build, which keeps their native libraries out of release bundles ([#439](https://github.com/patricktree/cup/issues/439)); Android's tombstones still report native crashes, through `sentry-android-core`.
  3. iOS: `Library/Caches/INSTALLATION` is recreated as a directory before the page loads, so the file cannot be written, and `contexts.app.device_app_hash`, stable across launches, is removed in `beforeSend` and at ingest.
  4. Both: the web app sets the user again once the native SDK runs, because a user set before then never reaches the native scope, and the SDK would otherwise fill in its installation ID.
- **Native session tracking and scope persistence are off,** so no session or scope file holds an ID, and release health for the shells is given up. A `pnpm patch` of `@sentry/capacitor` makes `enableAutoSessionTracking: false` reach the Cocoa SDK, which reads no manifest.
- **The organisation's scrubbing rule is the native enforcement point.** Native crashes, ANRs and hangs go straight to Sentry with no native `beforeSend`; the rule removes `contexts.device.id`, `contexts.app.device_app_hash` and a `user.id` in an installation ID format, which Android's ANR and tombstone events carry because they are reported from a later process.
- **Listeners can turn native capture off** with a "Send crash reports" switch in the shells' settings, on by default and stored on the device only, which deletes Sentry's on-device files ([#419](https://github.com/patricktree/cup/issues/419)).

## Considered options

- **Shells without native capture (`enableNative: false`).** The shells would report JS errors only. Native crashes, ANRs and app hangs would reach only the store consoles, which send no alert and which the operator checks by hand.
- **Native capture only after opt-in.** A consent prompt asks for consent the judgement above does not need, and a crash before the answer, or after a refusal, goes unseen. It was the fallback for iOS had the probe found no way to keep its installation ID off the device.
- **Keeping the SDKs' installation ID.** It is a telemetry-only identifier stored on the device, which the minimisation the legal judgement rests on rules out.

## Consequences

- The Android helper reaches into Sentry's internals, so a `@sentry/capacitor` update that moves the native SDK version fails the Android build until the pin moves; the mobile E2E suite then checks that two launches send different device IDs and that no ID file exists.
- Native ANR and tombstone events never carry the account ID, only an in-memory ID the scrubbing rule removes.
- A debug build of a shell sends nothing unless the mobile E2E suite passes it a Sentry stub's DSN, so development builds never reach production Sentry.
- The [observability page](../architecture/observability-clients.md#what-the-shells-send) and the [mobile app guide](../../apps/mobile-app/README.md#sentry) describe what is built.

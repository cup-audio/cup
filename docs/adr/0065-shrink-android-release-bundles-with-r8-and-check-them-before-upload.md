---
status: accepted
---

# Shrink Android release bundles with R8 and check them before upload

[ADR 0033](0033-ship-android-test-builds-from-the-operators-mac-to-google-plays-internal-testing-track.md) ships release-signed Android bundles from the operator's Mac to Google Play's internal testing track, with an upload key in the macOS Keychain and service-account impersonation for the Play Developer API. The release build itself needed decisions ADR 0033 does not record: how the bundle is shrunk, how Sentry finds the R8 mapping file, how a bundle is proven free of debug hooks, and how the scripts handle the upload key and the Play API. They were implemented with Linear CUP-80 in [cup-audio/cup#449](https://github.com/cup-audio/cup/pull/449) (R8 decided in [#437](https://github.com/cup-audio/cup/issues/437), the bundle safety check in [#438](https://github.com/cup-audio/cup/issues/438)); the quota project followed in commit `ebe8e404`. These decisions were recorded from code comments on 2026-11-23; the mobile app README's "Release builds" and "Bundle safety check" sections describe the commands.

## Decision

### The Gradle build

- R8 shrinks code and resources in [release builds](../../apps/mobile-app/android/app/build.gradle), and AGP embeds its mapping file in the bundle for Play's crash reports. Capacitor core's consumer rules keep every plugin class, so `proguard-rules.pro` holds no rules of its own (#437).
- `checkCupReleaseInputs` stops release tasks without valid version properties and upload key. It hooks `preReleaseBuild`, which runs first in every release variant task, such as `bundleRelease` and `assembleRelease`. Because invalid or missing values stop the build there, `androidComponents` applies the version only when it is valid, and the signing config stays empty without the environment.
- Sentry matches an event's obfuscated Java frames to R8's mapping file through a ProGuard UUID, which the SDK reads from the asset `sentry-debug-meta.properties`; `symbols:upload` uploads the mapping file under it. `GenerateSentryDebugMetaTask` writes that asset with the UUID `sentry-cli proguard uuid` computes: a UUIDv5 of the file's bytes in the namespace that is the UUIDv5 of `guardsquare.com` in the DNS namespace. [`sentry-debug-meta.mts`](../../apps/mobile-app/scripts/release/sentry-debug-meta.mts) reads it back from the bundle.
- Sentry's NDK integration is off (ADR 0031), and native crashes reach Sentry as Android tombstones through sentry-android-core. The build excludes `sentry-android-ndk` and `sentry-native-ndk`, whose modules only add native libraries, which the bundle safety check refuses.

### Failing before Gradle

- [`android-release.mts`](../../apps/mobile-app/scripts/android-release.mts) checks everything it can before the build starts, so a missing prerequisite fails before Gradle rather than after it: the Android SDK and Java 21, exiting with every problem; the Play credentials, read before the build unless `--skip-upload`; and the Sentry upload token through `sentry-cli info`, although `symbols:upload` runs it again before uploading.
- It deletes the previous bundle and merged manifest before Gradle runs, so a stale one cannot pass for this build's if Gradle writes none.

### The bundle safety check

- The [bundle safety check](../../apps/mobile-app/scripts/release/bundle-safety-check.mts) is what proves a release bundle is safe to hand to testers (#438). It refuses debug networking or the debug application class in the manifest; any class of the debug source set (`android/app/src/debug/java`, such as the mobile E2E suite's hooks, each a debug hook a release bundle must not contain) in any dex or as an original class in R8's mapping file; and any native library.
- It reads the merged release manifest Gradle writes as plain XML, because the bundle holds the manifest as protobuf.
- It finds a debug class in a dex by its class descriptor, which a dex file's string table holds as plain bytes.
- It reads R8's mapping file, which AGP embeds in the bundle, because R8 may rename a debug class that no keep rule covers, such as `TestApiOrigin`, so its dex descriptor changes; the mapping still lists it under its original name. Class lines read `original.Name -> obfuscated.Name:`, and member lines are indented.
- [`bundle-zip.mts`](../../apps/mobile-app/scripts/release/bundle-zip.mts) reads the bundle's zip entries with Node's zlib and no extra tools. It supports only what Gradle's bundles use: stored or deflated entries, no ZIP64, no encryption. It finds an entry's data through the name and extra field lengths of its local header, since they can differ from the central directory's.

### The upload key on the Mac

- [`android-upload-key-create.mts`](../../apps/mobile-app/scripts/android-upload-key-create.mts) generates a hex password, so it needs no quoting in `security -i` and has no leading dash. It writes the keystore first: if storing the password fails, deleting the new file undoes the run, so a retry passes the existence check. `security -i` reads the command from stdin, so the password never appears in a process list. It runs `keytool` with `-J-Duser.language=en`, because the certificate fingerprint labels are localized and English keeps them parseable.
- [`upload-key.mts`](../../apps/mobile-app/scripts/release/upload-key.mts) treats exit status 44 of `security find-generic-password` as no matching item; any other failure, such as a locked Keychain, ends the script. Without `-w` or `-g`, `security` prints the item's attributes but never its password, so the existence check cannot leak it. Reading the password with `-w` may make macOS ask the operator to allow access first.

### The Play upload

- [`play-upload.mts`](../../apps/mobile-app/scripts/release/play-upload.mts) uploads in one Play edit, which Play applies only on commit: any failure before the commit abandons the edit and leaves Play unchanged. A failure to abandon the edit only warns: the failing step's error is what the operator must see, and an uncommitted edit changes nothing in Play and expires on its own. The Play Developer API sits behind a small publisher interface so tests can fake it; [`google-play-publisher.mts`](../../apps/mobile-app/scripts/release/google-play-publisher.mts) implements it.
- The publisher's package name matches `appId` in `capacitor.config.ts` and `applicationId` in `android/app/build.gradle`. It reads the application-default credentials without a network request and impersonates the uploader service account on its first call. Minting a token for another account needs the source credentials' `cloud-platform` scope.
- `android:release` uploads the symbols to Sentry before the Play upload, so a Sentry failure stops the release before Play sees it (ADR 0033).

## Consequences

- A plugin that ships native libraries, or a Sentry module that adds them, fails the bundle safety check and so blocks a release.
- The ProGuard UUID algorithm is reproduced in Gradle and must stay equal to `sentry-cli`'s.
- The zip reader rejects ZIP64 or encrypted archives, should Gradle ever write them.

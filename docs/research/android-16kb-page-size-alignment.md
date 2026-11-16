# Android 16 KB page-size alignment

Research date: 2026-11-16, for [issue #436](https://github.com/patricktree/cup/issues/436) of the [Android test builds map](https://github.com/patricktree/cup/issues/355). Repository observations are from `main` at `8f4f6b9e`: Capacitor `8.5.3` (`@capacitor/android`), `@capacitor/app` `8.1.2`, `@aparajita/capacitor-secure-storage` `8.0.1`, `@capawesome/capacitor-google-sign-in` `0.1.4`, Android Gradle Plugin (AGP) `8.13.0`, Gradle wrapper `8.14.3`, `minSdkVersion 24`, `targetSdkVersion 36`. The evidence comes from a release bundle built on the operator's Mac the same day with Android Studio's bundled JDK; the tools were the `bundletool` `1.18.1` that AGP `8.13.0` itself depends on, run from the build's own classpath, and `zipalign` from SDK Build-Tools `36.0.0`. The bundle was unsigned: no upload key or debug keystore signed it or the APKs made from it. Google's pages carry no visible revision date; they were read on the research date.

## Question

Google Play requires apps targeting API 35+ to support 16 KB memory page sizes. Does Cup's release `.aab` contain any native `.so` libraries, from Capacitor or its plugins, and if so, are they 16 KB aligned as packaged? What, if anything, must the release build or a dependency upgrade change, and how can the release command or a check prove alignment on every release?

## Answer

**Cup's release bundle contains no native libraries, so it already meets the 16 KB requirement and needs no change.** The `.aab` has no `lib/` directory and no `.so` file in any ABI; Gradle skipped `:app:mergeReleaseNativeLibs` as `NO-SOURCE`; none of the 51 AARs and 66 JARs on the release runtime classpath carries a `jni/` folder or a `.so`; and `bundletool build-apks` produced no ABI split, only language and density splits, all of which pass `zipalign -c -P 16 -v 4`. Capacitor, its three plugins, AndroidX, Google Play services and Kotlin are all Java or Kotlin bytecode in this build.

Google's guide says such an app needs nothing: "If your app only uses code written in the Java programming language or in Kotlin, including all libraries or SDKs, then your app already supports 16 KB devices" ([page sizes guide][page-sizes]). Play's announcement says the same: "Apps with no native code should be compatible without any changes at all" ([Android Developers Blog, 2025-05-08][blog]).

**The bundle would also package future native libraries 16 KB aligned.** `bundletool dump config` reports `"alignment": "PAGE_ALIGNMENT_16K"` with `uncompressNativeLibraries` enabled, which is what AGP 8.5.1 and later write ([page sizes guide][page-sizes]). That covers the zip alignment Play applies when it makes APKs from the bundle; it does not cover the ELF `LOAD` segment alignment inside a `.so`, which only the library's own build sets. A plugin that later adds a native library brings its own ELF alignment, and that is what a release check has to catch.

**Recommended release check:** the `android:release` command fails when the built `.aab` contains any `.so`, and prints the paths. Cup expects none, so the first native library a dependency upgrade or a new plugin brings in stops the release until someone checks its alignment and widens the check on purpose. The check is one zip listing of the bundle and needs no extra tool; see [A check for every release](#a-check-for-every-release).

## Google's rules

- **Scope and dates.** "All apps targeting Android 15 (API level 35) and higher must support 16 KB memory page sizes on 64-bit devices on Google Play. Starting February 1, 2027, if your app updates don't support 16 KB memory page sizes, you won't be able to release these updates" ([page sizes guide][page-sizes]). Play's 2025 announcement had set 1 November 2025 for new apps and updates targeting Android 15+ ([blog][blog]); the guide's 1 February 2027 date is the later, current one for blocking updates. Cup targets API 36, so it is in scope.
- **Who has work to do.** An app "uses native code" if it has C/C++ code, links third-party native libraries or SDKs, or is built by an app builder that uses native libraries; an app whose code and libraries are all Java or Kotlin "already supports 16 KB devices" ([page sizes guide][page-sizes]).
- **Two alignments.** Uncompressed `.so` files must be 16 KB zip-aligned inside the APK (AGP 8.5.1 or higher does this), and each `.so` file's ELF `LOAD` segments must be aligned to `2**14` (NDK r28 or higher does this by default; r27 and lower need `-Wl,-z,max-page-size=16384`). Prebuilt libraries from SDKs must themselves be rebuilt that way ([page sizes guide][page-sizes]).
- **RELRO.** A `GNU_RELRO` segment that shares a writable `LOAD` segment must end on a 16 KB boundary, or the app crashes on a 16 KB device ([page sizes guide][page-sizes]). This only applies to `.so` files, so not to Cup today.
- **Verification Google documents.** APK Analyzer's `lib` folder and Alignment column; `check_elf_alignment.sh APK_NAME.apk`; `llvm-objdump -p SHARED_OBJECT_FILE.so | grep LOAD`, where no segment may show less than `2**14`; `zipalign -c -P 16 -v 4 APK_NAME.apk`, whose last line says "Verification successful"; and `bundletool dump config --bundle=<my .aab> | grep alignment`, which should show `PAGE_ALIGNMENT_16K` ([page sizes guide][page-sizes]). In the Play Console, the app bundle explorer page shows each build's compliance ([blog][blog]).

## Evidence from the release build

The build followed the [mobile app README](../../apps/mobile-app/README.md#build): `pnpm --filter '@cup/mobile-app' build` to build the web bundle and sync both native projects, then the Gradle release bundle. The release build type has no signing config, so `signReleaseBundle` left the bundle unsigned.

```sh
pnpm --filter '@cup/mobile-app' build
cd apps/mobile-app/android
JAVA_HOME="/Applications/Android Studio.app/Contents/jbr/Contents/Home" \
  ANDROID_HOME="${HOME}/Library/Android/sdk" ./gradlew bundleRelease
```

`app/build/outputs/bundle/release/app-release.aab`, 4,473,508 bytes, 607 entries:

| Check                                                              | Result                                                                                                                                    |
| ------------------------------------------------------------------ | ----------------------------------------------------------------------------------------------------------------------------------------- |
| `.so` entries in the `.aab` (`unzip -l`, any ABI)                  | 0; no `base/lib/` directory. Contents are `base/dex/classes.dex`, `base/assets` (web app), `base/res`, `base/root` and the manifest       |
| Gradle native library tasks                                        | `:app:mergeReleaseNativeLibs NO-SOURCE` and `:app:stripReleaseDebugSymbols NO-SOURCE`; every plugin module's `mergeReleaseNativeLibs` too |
| `jni/` or `.so` in release runtime classpath artifacts             | 0 of 51 AARs and 66 JARs (scan below)                                                                                                     |
| `bundletool dump config`                                           | `uncompressNativeLibraries: { enabled: true, alignment: PAGE_ALIGNMENT_16K }`                                                             |
| `bundletool build-apks` (default and `--mode=universal`, unsigned) | 83 split APKs (master, 2nd master, languages, densities; no ABI split) and one universal APK; no `lib/` entry in any                      |
| `zipalign -c -P 16 -v 4` on all 84 APKs                            | 84 pass, 0 fail; the universal APK ends with "Verification successful"                                                                    |
| `llvm-objdump -p` `LOAD` alignment                                 | Not applicable: no `.so` to inspect                                                                                                       |

### Where each part of the bundle comes from

No `.so` exists, so the per-ABI table the ticket asks for is empty. The dependencies that could have brought one, all scanned:

| Origin                                         | Release artifacts on the runtime classpath                                                                                                                            | Native code |
| ---------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------- |
| `@capacitor/android` `8.5.3`                   | `:capacitor-android` project, `org.apache.cordova:framework:14.0.1`, `androidx.webkit:webkit:1.14.0`, AndroidX AppCompat, Fragment, Activity, Core, CoordinatorLayout | None        |
| `@capacitor/app` `8.1.2`                       | `:capacitor-app` project                                                                                                                                              | None        |
| `@aparajita/capacitor-secure-storage` `8.0.1`  | `:aparajita-capacitor-secure-storage` project, `androidx.biometric:biometric:1.1.0`                                                                                   | None        |
| `@capawesome/capacitor-google-sign-in` `0.1.4` | `:capawesome-capacitor-google-sign-in` project, `androidx.credentials` `1.5.0`, `googleid` `1.1.1`, `play-services-auth` `21.5.0` and its Play services modules       | None        |
| The app module                                 | `core-splashscreen` `1.2.0`, Kotlin standard library, kotlinx-coroutines, `:capacitor-cordova-android-plugins` (no Cordova plugins)                                   | None        |

The full scan listed each artifact of the app's `releaseRuntimeClasspath` (as `aar` and as `jar` artifact views, through a throwaway Gradle init script) and searched every archive for `jni/`, `lib/<abi>/` or `.so` entries; it found none. Unpacked project modules had no `.so` file either, and no `CMakeLists.txt`, `jniLibs` or prebuilt `.so` exists in the Capacitor or plugin packages under `node_modules`.

### Running bundletool without installing it

`bundletool` is not on the Mac's `PATH`, but AGP depends on it, so the Gradle cache already holds `bundletool-1.18.1.jar` and its dependencies. A throwaway init script ran it from the root project's buildscript classpath as a `JavaExec` task with main class `com.android.tools.build.bundletool.BundleToolMain`. `build-apks` needed `--aapt2` pointing at Build-Tools `36.0.0`, since the AGP-resolved jar ships no `aapt2`, and ran with `HOME` and `user.home` set to an empty directory so it found no debug keystore and wrote unsigned APKs (it warns that they are not installable). Nothing was downloaded.

## A check for every release

What has to hold for every upload is that each `.so` in the bundle is 16 KB aligned both ways. Today that means the bundle has no `.so`, which is the cheapest thing to prove:

1. **Fail on any native library.** After `./gradlew bundleRelease`, list the bundle's entries (`unzip -Z1 app-release.aab`, or a zip reader in the Node release script) and fail if any ends in `.so`, printing them. This needs no SDK tool, runs in under a second, and turns "a plugin started shipping native code" into a deliberate decision instead of a silent Play rejection after 1 February 2027.
2. **Optionally assert the packaging setting.** `bundletool dump config --bundle=app-release.aab` must report `PAGE_ALIGNMENT_16K`. This only changes with an AGP downgrade or an explicit `useLegacyPackaging` setting, so it is a weak guard while there are no native libraries, and it costs a `bundletool` invocation the release command does not otherwise need.

If Cup ever accepts native libraries, the check grows into Google's documented steps instead of the hard failure: run `bundletool build-apks` (unsigned, or with the upload key the release command already reads), extract the APKs, run `zipalign -c -P 16 -v 4` on each, and for each `arm64-v8a` and `x86_64` `.so` require every `LOAD` line of `llvm-objdump -p` to show `2**14` or more and the `GNU_RELRO` rule to hold. That needs the NDK's `llvm-objdump` (NDK `27.1.12297006` is installed on the Mac) and a `bundletool`, either through AGP's classpath as above or a pinned jar. Checking the `.aab` alone is not enough then, because Play generates the APKs: the bundle config sets their zip alignment, and only the `.so` files' own ELF headers show segment alignment.

After the first upload, the Play Console's app bundle explorer shows the same verdict per build ([blog][blog]); it is a confirmation after the fact, not a pre-upload gate.

## Unverified

- The Play Console's own Help Center was not found to state the 16 KB requirement or the app bundle explorer's display; the rule and dates above come from developer.android.com and the Android Developers Blog post by Google Play. The exact label the app bundle explorer shows for a compliant build was not seen, because Cup has no Play Console app yet.
- The app was not run on a 16 KB device or emulator image (`adb shell getconf PAGE_SIZE` returning `16384`). Google recommends that test even for Java and Kotlin apps ([page sizes guide][page-sizes]); with no native code, nothing in Cup depends on the page size, but the WebView is the system's, outside the app.
- Only the release variant was inspected. The debug variant adds no runtime dependency with native code to the release ones (`androidx.webkit` is already on the release classpath through Capacitor), but it was not scanned.

[page-sizes]: https://developer.android.com/guide/practices/page-sizes
[blog]: https://android-developers.googleblog.com/2025/05/prepare-play-apps-for-devices-with-16kb-page-size.html

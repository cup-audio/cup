# R8 for Cup's Android release builds

> Historical research, incorporated 2026-11-18. It is the evidence behind the [R8 section](../../apps/mobile-app/README.md#build-a-release) of the mobile guide: Capacitor was upgraded past 8.6.0 and release builds shrink with the optimizing defaults and no Cup keep rules, as recommended ([#437](https://github.com/cup-audio/cup/issues/437), measured again in [#444](https://github.com/cup-audio/cup/issues/444)). Unlike its recommendation to upload nothing extra, `android:release` also uploads the mapping file to Sentry, whose release tracking ([#403](https://github.com/cup-audio/cup/issues/403)) landed meanwhile. [Original](https://github.com/cup-audio/cup/blob/8651ed17a6aa39b15d761d98ed0d94217147a8e3/docs/research/android-release-r8.md) on the unmerged branch `research/android-release-r8`.

Research date: 2026-11-16, for [issue #437](https://github.com/patricktree/cup/issues/437) of the [Android test builds map](https://github.com/patricktree/cup/issues/355). Repository observations are from `main` at `8f4f6b9e`: Android Gradle Plugin (AGP) `8.13.0` with its bundled R8 `8.13.6`, Gradle `8.14.3`, JDK 21, `minSdkVersion` 24, `@capacitor/android` `8.5.3`, `@capacitor/app` `8.1.2`, `@aparajita/capacitor-secure-storage` `8.0.1` and `@capawesome/capacitor-google-sign-in` `0.1.4` (androidx Credentials `1.5.0`, `googleid` `1.1.1`, `play-services-auth` `21.5.0` by the plugin's defaults). Four unsigned `bundleRelease` builds ran on this Mac with temporary `build.gradle` and `proguard-rules.pro` edits, which were reverted. No signing key was created or used, nothing was installed on a device and nothing was uploaded to Play, so every statement about runtime behaviour on a device is _unverified_.

## Question

`apps/mobile-app/android/app/build.gradle` sets `minifyEnabled false` for `release`. Should release builds turn on R8 code shrinking, optimization and obfuscation, and resource shrinking? What do Capacitor and each plugin need kept, from consumer rules the libraries ship or from rules Cup must add? What are the risks (reflection in the Capacitor bridge, plugin method lookup, native Google sign-in)? How much smaller does the `.aab` get? Does Play then need the mapping file uploaded for readable crash reports?

## Answer

- **Yes, enable it, with the optimizing defaults.** Set `minifyEnabled true`, `shrinkResources true` and `getDefaultProguardFile('proguard-android-optimize.txt')`. Android Developers say "You should always enable optimization for your app's release build" ([Enable app optimization][enable-opt]). Capacitor 9's app template ships exactly this release block, while Capacitor 8's still has `minifyEnabled false` ([templates](#capacitor-itself)). The existing `proguard-android.txt` must go: it disables optimization (`-dontoptimize`), and AGP 9 no longer accepts it ([AGP and R8 version behavior changes][enable-opt]).
- **Upgrade `@capacitor/android` to 8.6.0 or later first, or add four rules.** Capacitor's consumer rules in `8.5.3` keep every plugin class and its `@PluginMethod` methods, but not the annotation types. In Cup's optimized build, R8 removed `PluginHandle`'s cached `@CapacitorPlugin` annotation field, the defect reported in [capacitor#8589][cap-8589]. Capacitor 8.6.0 ships the fix as consumer rules ([#8646][cap-8646], [#8657][cap-8657]). Cup's four plugins do not use the affected permission and activity-result paths, so this probably does not crash Cup today. With the fix, Cup needs **no rules of its own**.
- **The plugins ship no rules, and need none beyond Capacitor's.** `@capacitor/app`, `@aparajita/capacitor-secure-storage` and `@capawesome/capacitor-google-sign-in` declare no `consumerProguardFiles`; their published packages contain no rules file. Capacitor core's consumer rule `-keep public class * extends com.getcapacitor.Plugin { *; }` keeps each plugin class whole, including Cup's own `AndroidSharePlugin`. The Google libraries ship their own rules, including the one that keeps Credential Manager's reflectively loaded Play services provider. The mapping confirms that every plugin class kept its name.
- **Size.** Dex code drops from 8.9 MB to 1.2 MB uncompressed (3.1 MB to 0.53 MB compressed). Resource shrinking removes 83 of 437 resource files. The parts of the `.aab` that reach a device shrink from about 4.3 MB to about 1.6 MB compressed. The `.aab` itself shrinks from 4.47 MB to 2.53 MB, although it now also carries the 0.74 MB compressed mapping file.
- **No mapping upload is needed.** AGP writes `mapping.txt` into the bundle's metadata, and Play reads it from there: "If you're using an app bundle and Android Gradle plugin version 4.1 or later, then there's nothing you need to do" ([Deobfuscate or symbolicate crash stacks][play-deobfuscate]). The upload script from [#363](https://github.com/patricktree/cup/issues/363) needs no `edits.deobfuscationfiles.upload` call.
- **Risks left to a device test.** R8 logs 26 "Invalid stack map table" warnings inside `play-services-auth` `21.5.0`, saying a later R8 "may" treat those methods as unreachable. Sign-in through Credential Manager therefore needs a check on a Play-installed R8 build, which the map's acceptance check already is. The mobile E2E suite runs debug builds, so it never exercises R8.

## Cup's native dependencies

`cap sync android` lists three npm plugins, all wired in through generated Gradle files. `capacitor.settings.gradle` includes `:capacitor-android`, `:aparajita-capacitor-secure-storage`, `:capacitor-app` and `:capawesome-capacitor-google-sign-in` from `node_modules`. `app/capacitor.build.gradle` adds the three plugins as `implementation project(...)`. `app/build.gradle` adds `capacitor-android`, the empty `capacitor-cordova-android-plugins` project, AppCompat, CoordinatorLayout and SplashScreen. The app has one native plugin of its own, `AndroidSharePlugin` in `src/main`, registered in `MainActivity`. The debug source set's test hooks and sign-in fake are not part of a release build.

| Module                                         | Native libraries it pulls in                                                                                           | Consumer rules shipped                                                                                                                                                             |
| ---------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `@capacitor/android` `8.5.3`                   | AndroidX AppCompat, Core, Activity, Fragment, CoordinatorLayout, WebKit; `org.apache.cordova:framework` `14.0.1`       | Yes: `consumerProguardFiles 'proguard-rules.pro'`, keeping plugin classes, `@PluginMethod` methods, callbacks and Cordova plugin subclasses. No annotation-type keeps before 8.6.0 |
| `@capacitor/app` `8.1.2`                       | AppCompat                                                                                                              | None. `build.gradle` has no `consumerProguardFiles`, and the package's `files` list leaves out any rules file. Upstream `main` has the same template-only file                     |
| `@aparajita/capacitor-secure-storage` `8.0.1`  | AppCompat; Android Keystore from the platform                                                                          | None, as above (upstream `main` too)                                                                                                                                               |
| `@capawesome/capacitor-google-sign-in` `0.1.4` | androidx `credentials` and `credentials-play-services-auth` `1.5.0`, `googleid` `1.1.1`, `play-services-auth` `21.5.0` | None from the plugin (upstream `main` too). Its libraries ship rules: see [Credential Manager and Google sign-in](#credential-manager-and-google-sign-in)                          |
| App module (`audio.cup.app`)                   | `core-splashscreen` `1.2.0`, AppCompat, CoordinatorLayout                                                              | `proguard-rules.pro` holds only the template's comments                                                                                                                            |

R8 writes every rule it applied, with the file it came from, to `app/build/outputs/mapping/release/configuration.txt` ([Test and troubleshoot the optimization][troubleshoot]). In Cup's build that report lists consumer rules from Capacitor core, 27 AndroidX and Google Play services AARs, the coroutines and AndroidX annotations jars, AAPT's generated rules for manifest and layout classes, and the AGP default file. None of the three npm plugins appears in it.

## Capacitor itself

Capacitor's documentation does not cover minification. The [Deploying to Google Play][cap-deploy] guide does not mention R8, ProGuard or mapping files. What Capacitor needs kept is defined by its consumer rules and its source.

**How the bridge finds plugin code.** Every lookup is reflective, and each one is covered by a rule:

- `PluginManager` loads each plugin listed in `assets/capacitor.plugins.json` by name with `Class.forName(classPath)`. The three class names Cup's file lists (`com.aparajita.capacitor.securestorage.SecureStorage`, `com.capacitorjs.plugins.app.AppPlugin`, `io.capawesome.capacitorjs.plugins.googlesignin.GoogleSignInPlugin`) kept their names in the optimized build's `mapping.txt`, as did `audio.cup.app.AndroidSharePlugin`.
- `PluginHandle` reads the `@CapacitorPlugin` annotation, then lists the class's public methods with `getMethods()` and keeps those annotated `@PluginMethod`. It creates the plugin with `getDeclaredConstructor().newInstance()` and calls methods with `Method.invoke`. The core rule `-keep public class * extends com.getcapacitor.Plugin { *; }` keeps every member of every public plugin class.
- The WebView calls `MessageHandler.postMessage`, `CapacitorHttp.isEnabled` and `CapacitorCookies` methods through `@JavascriptInterface`. Both AGP default files keep `@android.webkit.JavascriptInterface` methods, and `postMessage` appears unrenamed in `seeds.txt`.

**The annotation defect in `8.5.3`.** [capacitor#8589][cap-8589] reports that R8 full mode, the default since AGP 8.0, folds `PluginHandle.getPluginAnnotation()` to `null`, because nothing keeps the annotation interfaces themselves. The reporter's setup matches Cup's: AGP `8.13.0`, R8 `8.13.6`, `proguard-android-optimize.txt`. Cup's build reproduces it. With `proguard-android-optimize.txt`, `PluginHandle` lost its `pluginAnnotation` and `legacyPluginAnnotation` fields in `mapping.txt`. With `proguard-android.txt`, which turns optimization off, both fields remained. With Capacitor 8.6.0's added rules in `proguard-rules.pro`, both fields remained under optimization too. A `null` annotation breaks Capacitor's permission methods (`checkPermissions`, `requestPermissions`, `getPermissionState`) and the deprecated request-code lookup. Version 8.5.2 added `null` checks against the crash ([#8400][cap-8400]). Cup's native plugins declare no permissions and use no `@ActivityCallback` or `@PermissionCallback`, and the web app calls no `checkPermissions` or `requestPermissions`, so Cup should not reach those paths. Capacitor 8.6.0 (2026-10-28) fixes the cause in its consumer rules: `-keep @interface com.getcapacitor.annotation.** { *; }`, `-keep @interface com.getcapacitor.PluginMethod { *; }`, `-keep @interface com.getcapacitor.NativePlugin { *; }` and a `-keepclassmembers` rule for callbacks declared on non-public base classes ([8.6.0 release notes][cap-860]). 8.6.2 is the latest Capacitor 8 release; `@capacitor/app`, the secure storage plugin and the Google sign-in plugin are already at their latest versions.

**Capacitor's direction.** A maintainer wrote on [capacitor#8587][cap-8587] that the team is adding missing rules to core and its own plugins in Capacitor 8 patch releases, and that "The use of AGP 9 and setting `minifyEnabled` to `true` by default, will only happen in Capacitor 9". Capacitor's app template confirms it: at tag `8.6.2` the release block is `minifyEnabled false` with `proguard-android.txt`, at `9.0.0-rc.0` it is `minifyEnabled true` with `proguard-android-optimize.txt` ([8.6.2 template][cap-template-8], [9.0.0-rc.0 template][cap-template-9]).

## Credential Manager and Google sign-in

The sign-in plugin calls `CredentialManager.getCredentialAsync` with a `GetSignInWithGoogleOption` and parses the result with `GoogleIdTokenCredential.createFrom`, all as ordinary method calls that R8 can trace. The reflective step is inside androidx Credentials: it finds its Play services provider, `androidx.credentials.playservices.CredentialProviderPlayServicesImpl`, at runtime. `credentials-play-services-auth` `1.0.0-alpha09` shipped without a rule for it, which [b/288120539][credentials-bug] reported. The [Credentials release notes][credentials-releases] list "Fixed missing Proguard rules (b/288120539)" in `1.2.0-beta03`. The `1.5.0` AAR Cup resolves carries the rule:

```proguard
-if class androidx.credentials.CredentialManager
-keep class androidx.credentials.playservices.CredentialProviderPlayServicesImpl {
  *;
}
```

The optimized build kept that class unrenamed. `googleid` `1.1.1` ships only `-dontwarn module-info`, and `play-services-auth` `21.5.0` keeps `RevocationBoundService` and Google API client `@Key` fields. The Play services base, basement, tasks, FIDO and identity-credentials AARs bring their own rules too.

R8 printed 26 warnings of this form for classes in `play-services-auth-21.5.0-runtime.jar`, the same 26 with and without optimization:

> R8: Invalid stack map table at instruction index 2: invokespecial Ljava/lang/Object;\<init\>()V, error: Constructor mismatch, expected constructor from com.google.android.gms.auth.api.identity.zbc, but was java.lang.Object.\<init\>(). In later version of R8, the method may be assumed not reachable.

All 26 are in obfuscated `com.google.android.gms.auth.api.identity`, `auth.api.signin` and `internal.auth-api` classes, which back the `Identity` sign-in and authorization clients. The build succeeded, and R8 `8.13.6` does not yet act on them. No Google issue or release note about these warnings for `play-services-auth` `21.5.0` was found. Whether they affect sign-in on a device is _unverified_. They are also a reason to re-check sign-in after any AGP or R8 upgrade.

Signing certificates are unaffected: R8 changes code, not signing, so the fingerprints and Android OAuth clients from [#357](https://github.com/patricktree/cup/issues/357) and [#366](https://github.com/patricktree/cup/issues/366) stay as decided.

## Size

Four unsigned `bundleRelease` builds from the same commit and the same web assets (`cap sync android` after `turbo:build`). The `.aab` has no `META-INF` signature files, so it is unsigned. Sizes are bytes from `unzip -lv`. "Compressed" is the bundle's own zip compression, which is close to, but not the same as, what Play serves in its split APKs.

| Build                                                          | `.aab`    | `classes.dex` uncompressed / compressed | `res/` files, compressed | `resources.pb` compressed | Mapping in `BUNDLE-METADATA`, compressed |
| -------------------------------------------------------------- | --------- | --------------------------------------- | ------------------------ | ------------------------- | ---------------------------------------- |
| Today: `minifyEnabled false`                                   | 4,473,511 | 8,933,044 / 3,132,767                   | 437, 238,366             | 161,306                   | none                                     |
| R8 + `shrinkResources`, `proguard-android.txt`                 | 2,613,617 | 1,746,456 / 735,445                     | 354, 189,357             | 144,544                   | 629,136                                  |
| R8 + `shrinkResources`, `proguard-android-optimize.txt`        | 2,529,303 | 1,160,072 / 533,063                     | 354, 189,357             | 144,515                   | 740,999                                  |
| As above, plus Capacitor 8.6.0's annotation and callback rules | 2,530,996 | 1,161,828 / 534,351                     | 354, 189,357             | 144,515                   | about the same                           |

The web app under `assets/public` is unchanged at 782,245 bytes compressed. Adding up dex, resources, resource table and assets, the device-bound part drops from about 4.31 MB to about 1.65 MB compressed, a cut of about 62%. Per-device APK sizes would need `bundletool build-apks`, which signs the APKs, so they were not measured. The 83 removed resource files are unused AppCompat and Material drawables, layouts, animations and colours, plus the Capacitor template's unused `drawable/ic_launcher_background.xml`, `drawable-v24/ic_launcher_foreground.xml`, `compat_splash_screen.xml` and `splash_screen_view.xml`. The adaptive icon uses `@mipmap/ic_launcher_foreground` and `@color/ic_launcher_background`, and the launch theme uses `@drawable/splash`, all of which remained.

R8 records its own coverage in the bundle's `r8.json`, which Android vitals reads for its DEX code optimization finding ([DEX code optimization][dex-vitals]):

| Build                           | Obfuscated | Optimized | Shrunk |
| ------------------------------- | ---------- | --------- | ------ |
| `proguard-android.txt`          | 93.3%      | 0%        | 93.1%  |
| `proguard-android-optimize.txt` | 87.0%      | 85.2%     | 86.6%  |
| With Capacitor 8.6.0 rules      | 86.9%      | 85.1%     | 86.4%  |

Google Play says that "Starting in February 2027", apps must meet a DEX code optimization threshold of "a minimum of 25% coverage across optimization, shrinking, and obfuscation" ([Android Developers Blog][play-quality-blog]). Android vitals enforces it only when the "Bundle contains at least 10 MB of DEX code measured as uncompressed size" ([DEX code optimization][dex-vitals]). Cup's unoptimized dex is 8.9 MB, just under that line. A `proguard-android.txt` build would fail the optimization metric if Cup's code grew past it.

## Stack traces and the mapping file

AGP writes `mapping.txt`, `configuration.txt`, `seeds.txt`, `usage.txt` and `resources.txt` to `app/build/outputs/mapping/release/`. It also embeds the mapping in the bundle as `BUNDLE-METADATA/com.android.tools.build.obfuscation/proguard.map`, byte-for-byte identical to `mapping.txt` in Cup's build. Android Developers: "The mapping file, called `mapping.txt`, is automatically bundled with your Android App Bundle (AAB)" ([Test and troubleshoot the optimization][troubleshoot]). The Play Console help page says nothing is needed for an app bundle built with AGP 4.1 or later. A manual upload under App bundle explorer › Downloads › Assets "is only required for developers using APKs" ([Deobfuscate or symbolicate crash stacks][play-deobfuscate]). The Android Publisher API has [`edits.deobfuscationfiles.upload`][publisher-deobfuscation] for APK version codes, but Cup's script uploads a bundle with `edits.bundles.upload`, which carries the mapping, so the script needs no extra step.

Line numbers survive without extra rules. R8's mapping has line ranges for each method, and AGP 8.6 and later include "filename and line number retracing by default for all `minSdk` levels" ([AGP and R8 version behavior changes][enable-opt]). The template's commented-out `-keepattributes SourceFile,LineNumberTable` can stay commented. A local stack trace is retraced with `retrace` from the command-line tools and the build's `mapping.txt` ([Test and troubleshoot the optimization][troubleshoot]). That page also notes that the file "is overwritten every time you build your project". Play reads the copy inside each uploaded bundle, so Cup has no reason to archive the file separately.

## Recommendation

Enable R8 in the release build that this map's spec defines, before the first internal testing upload, so that testers and the acceptance check run the build Cup will publish:

1. Upgrade `@capacitor/android`, `@capacitor/core`, `@capacitor/ios` and `@capacitor/cli` to 8.6.0 or later, which adds the annotation and callback keep rules as consumer rules. If the upgrade must wait, put those four rules in `app/proguard-rules.pro` with a comment that names Capacitor 8.6.0, and delete them on upgrade.
2. In `app/build.gradle`'s `release` block, set `minifyEnabled true` and `shrinkResources true`, and switch to `getDefaultProguardFile('proguard-android-optimize.txt')`. Keep `proguard-rules.pro` free of Cup-specific rules; add one only for a crash reproduced in a release build, scoped to the class involved.
3. Leave `android.r8.optimizedResourceShrinking` off on AGP 8.13. It is opt-in there and becomes the default with AGP 9 ([Enable app optimization][enable-opt]), so it arrives with that upgrade.
4. Upload nothing extra: the `.aab` carries the mapping file.
5. Add R8-specific checks to the manual release-build checks in [CUP-44](https://linear.app/cup-audio/issue/CUP-44/test-the-android-and-ios-apps-native-functionality-on-physical-devices) and the map's acceptance check: Google sign-in and sign-out, secure storage surviving an app restart, a text share from another app, and the back button. Network requests through `CapacitorHttp` are already on that list. If sign-in fails only in the R8 build, try `-keep class com.google.android.gms.auth.api.identity.** { *; }` first, given the stack map warnings.
6. Record the choice in the spec and the mobile app README's release section. An ADR is optional, since reverting is a one-line change.

## Unverified

- Runtime behaviour of an R8 build on a device. No R8 build was installed or launched.
- Whether the 26 `play-services-auth` stack map warnings affect Credential Manager sign-in.
- Per-device download and install sizes from Play's split APKs; the figures above are bundle-internal.
- Android vitals' own percentages. `android analyze`, which reproduces them ([DEX code optimization][dex-vitals]), is not installed here; the table shows R8's `r8.json`, which Android vitals reads for AGP 8.10.1 and later.

## Sources

- [Enable app optimization][enable-opt], including "AGP and R8 version behavior changes", Android Developers.
- [Test and troubleshoot the optimization][troubleshoot], Android Developers.
- [DEX code optimization][dex-vitals], Android Developers (Android vitals).
- [Google Play's app quality requirements announcement][play-quality-blog], Android Developers Blog, August 2026.
- [Deobfuscate or symbolicate crash stacks][play-deobfuscate], Play Console Help.
- [`edits.deobfuscationfiles.upload`][publisher-deobfuscation], Google Play Developer API.
- [Credentials release notes][credentials-releases], Android Developers, and [b/288120539][credentials-bug], Google Issue Tracker.
- [Deploying to Google Play][cap-deploy], Capacitor documentation.
- Capacitor issues and pull requests: [#8587][cap-8587], [#8589][cap-8589], [#8400][cap-8400], [#8646][cap-8646], [#8657][cap-8657]; [8.6.0 release notes][cap-860]; app template at [8.6.2][cap-template-8] and [9.0.0-rc.0][cap-template-9]; consumer rules at [8.6.2][cap-rules-862].
- Plugin repositories on `main`: [`@capacitor/app`][app-gradle], [`@capawesome/capacitor-google-sign-in`][gsi-gradle], [`@aparajita/capacitor-secure-storage`][secure-storage-gradle].
- Local: the installed packages' `build.gradle`, `proguard-rules.pro` and Java sources in `node_modules`; AAR `proguard.txt` files in `~/.gradle/caches/8.14.3/transforms`; and each build's `configuration.txt`, `mapping.txt`, `seeds.txt`, `r8.json` and `unzip -lv` listing.

[enable-opt]: https://developer.android.com/topic/performance/app-optimization/enable-app-optimization
[troubleshoot]: https://developer.android.com/topic/performance/app-optimization/test-and-troubleshoot-the-optimization
[dex-vitals]: https://developer.android.com/google/play/vitals/code-optimization
[play-quality-blog]: https://android-developers.googleblog.com/2026/08/app-quality-memory-optimization-secure-onboarding.html
[play-deobfuscate]: https://support.google.com/googleplay/android-developer/answer/9848633
[publisher-deobfuscation]: https://developers.google.com/android-publisher/api-ref/rest/v3/edits.deobfuscationfiles/upload
[credentials-releases]: https://developer.android.com/jetpack/androidx/releases/credentials
[credentials-bug]: https://issuetracker.google.com/issues/288120539
[cap-deploy]: https://capacitorjs.com/docs/android/deploying-to-google-play
[cap-8587]: https://github.com/ionic-team/capacitor/issues/8587
[cap-8589]: https://github.com/ionic-team/capacitor/issues/8589
[cap-8400]: https://github.com/ionic-team/capacitor/pull/8400
[cap-8646]: https://github.com/ionic-team/capacitor/pull/8646
[cap-8657]: https://github.com/ionic-team/capacitor/pull/8657
[cap-860]: https://github.com/ionic-team/capacitor/releases/tag/8.6.0
[cap-template-8]: https://github.com/ionic-team/capacitor/blob/8.6.2/android-template/app/build.gradle
[cap-template-9]: https://github.com/ionic-team/capacitor/blob/9.0.0-rc.0/android-template/app/build.gradle
[cap-rules-862]: https://github.com/ionic-team/capacitor/blob/8.6.2/android/capacitor/proguard-rules.pro
[app-gradle]: https://github.com/ionic-team/capacitor-plugins/blob/main/app/android/build.gradle
[gsi-gradle]: https://github.com/capawesome-team/capacitor-plugins/blob/main/packages/google-sign-in/android/build.gradle
[secure-storage-gradle]: https://github.com/aparajita/capacitor-secure-storage/blob/main/android/build.gradle

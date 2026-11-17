---
status: accepted
---

# Ship Android test builds from the operator's Mac to Google Play's internal testing track

Until November 2026 Cup's Android app was only ever a debug build installed with `adb` on the operator's own devices: no release-signed build existed, testers could not install Cup, and real Google sign-in worked only for builds signed with the operator's debug keystore. Linear CUP-80 asked for test builds through Google Play's internal testing track. The map [patricktree/cup#355](https://github.com/patricktree/cup/issues/355) settled how between 2026-11-12 and 2026-11-14, in [#356](https://github.com/patricktree/cup/issues/356) (Play's requirements), [#360](https://github.com/patricktree/cup/issues/360) (the upload key), [#358](https://github.com/patricktree/cup/issues/358) and [#363](https://github.com/patricktree/cup/issues/363) (the upload), and the spec [#439](https://github.com/patricktree/cup/issues/439) collected the decisions. The repository has no CI workflows; deploys already run from the operator's Mac.

## Decision

- **Play App Signing with a Google-generated app signing key.** The first upload, made by hand in the Play Console because the Play Developer API needs an existing upload, enrols the app and fixes the app signing key. Google holds that key; Cup's own key is only the upload key, and Play re-signs every uploaded bundle before testers install it.
- **The upload key stays outside the repository.** It is a gitignored PKCS12 keystore in the checkout, `apps/mobile-app/android/upload-keystore.jks`, whose one password is a macOS Keychain generic-password item (service `cup-android-upload-key`). `android:upload-key:create` makes both once without printing the password; the operator backs both up in a password manager. Postinstall copies the keystore into linked worktrees. Installs, `env:check` and the validation gates never need it.
- **One command on the operator's Mac builds and ships a test build.** `android:release` refuses unless tracked files are clean, `HEAD` is on a remote-tracking branch and the upload key is in place, then builds a release bundle with the version from [ADR 0032](0032-derive-mobile-build-versions-from-the-utc-build-time.md). It hands Gradle the password and keystore path as environment variables, never as arguments, and a release task without them fails, so no unsigned release bundle exists. `--skip-upload` stops after the build.
- **Uploads are scripted through service-account impersonation.** After the first manual upload, the command uploads through the Play Developer API in one edit and rolls the release out to the internal track as `completed`. It authenticates by impersonating a Terraform-managed service account in `cup-production` through the operator's own `gcloud` application-default login, so no JSON key exists to leak, back up or rotate.
- **No uploads from CI.** Test builds ship only from the operator's Mac, and agents upload only when the operator asks in the session; `--skip-upload` is free to run.

## Considered options

- **Upload an app signing key Cup generates.** Rejected: Cup would have to keep a key it can never replace, while a lost upload key under a Google-generated app signing key is recoverable through Play's upload key reset.
- **Keep the keystore password in a gitignored file, such as `.env.local`.** Rejected: a plain-text secret next to the keystore would leak with it; the Keychain keeps the password encrypted and shared across all checkouts on the Mac.
- **Upload by hand in the Play Console every time.** Rejected: every test build would take a Console session; only the first upload must be manual.
- **Gradle Play Publisher or fastlane.** Rejected in [#363](https://github.com/patricktree/cup/issues/363): Gradle Play Publisher is pinned to an old release by AGP 8 and in maintenance mode, and fastlane needs Ruby; a small Node script on `@googleapis/androidpublisher` fits the pnpm workspace.
- **A service account JSON key.** Rejected as the default: a long-lived key needs storage, backup and rotation. It stays the fallback if the Play API refuses impersonated tokens.
- **Uploads from CI.** Rejected: the repository has no CI, and CI would need the upload key and a Play credential stored outside the Mac.

## Consequences

- Only the operator's Mac can ship a test build; losing it means restoring the keystore and password from the password manager, or asking Google for an upload key reset.
- Google sign-in in Play-installed builds needs Android OAuth clients for Play's app signing certificates, which exist only after the first upload.
- A build from a feature branch replaces every tester's build until a later upload.
- As of 2026-11-16, the upload key creation ([#441](https://github.com/patricktree/cup/issues/441)), the uploader service account ([#445](https://github.com/patricktree/cup/issues/445)) and `android:release --skip-upload` ([#442](https://github.com/patricktree/cup/issues/442)) and the scripted upload ([#446](https://github.com/patricktree/cup/issues/446)) are built; no scripted upload has run yet, so whether the Play API accepts impersonated tokens is unconfirmed until the first one.

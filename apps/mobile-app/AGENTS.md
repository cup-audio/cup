# Mobile App Instructions

- For native builds, device setup, or mobile backend limitations, read `README.md` in this directory.
- The tracked Xcode project signs both targets, `App` and `CupShare`, with team `4GQ2V3WJW8`, the Apple Developer team that owns both bundle identifiers and publishes Cup to the App Store. Keep it: it is the project's team, not a personal assignment, although the account is an individual one.
- A developer outside team `4GQ2V3WJW8` passes `DEVELOPMENT_TEAM=<team-id>` to `xcodebuild` for local iOS device builds instead of changing the project. Keep any other team ID, Xcode's free Personal Team especially, out of the tracked Xcode project.
- The `App` target signs with the Sign in with Apple entitlement from the tracked `ios/App/App/App.entitlements` in every configuration; `CupShare` has none. Keep both. Another team's device build also passes `CODE_SIGN_ENTITLEMENTS=` (empty) to `xcodebuild`, and Sign in with Apple then fails on that build with Cup's ordinary error ([README](README.md#ios)).
- The Android app signs in with Apple through Cup's own `WebAuthenticationPlugin`, which opens Supabase's web flow in a Custom Tab and never in Chrome's Auth Tab, so the path the mobile E2E suite tests is the one production uses ([README](README.md#android-sign-in-with-apple)).
- Xcode's team selector writes `DEVELOPMENT_TEAM` into `ios/App/App.xcodeproj/project.pbxproj`; inspect the diff after configuring signing and revert any team other than `4GQ2V3WJW8` before handoff.
- Verify installation and launch separately. Device setup is complete when the app launches and its UI renders, confirmed by inspection or the user.

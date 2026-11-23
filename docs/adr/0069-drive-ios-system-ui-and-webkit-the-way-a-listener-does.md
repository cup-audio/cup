---
status: accepted
---

# Drive iOS system UI and WebKit the way a listener does

The iOS specs tap through Safari's Share Sheet, the `ASWebAuthenticationSession` prompt and Cup's WebView in the simulator, so Safari's and WebKit's behaviour shapes each step ([ADR 0018](0018-test-the-mobile-apps-with-appium-through-webdriverio-on-host-owned-emulators-and-simulators.md): a change to Safari's Share Sheet fails the suite). The Share Sheet steps landed with the suite in [cup-audio/cup#211](https://github.com/cup-audio/cup/pull/211); the sign-in prompt with [cup-audio/cup#227](https://github.com/cup-audio/cup/pull/227) ([ADR 0019](0019-sign-in-on-ios-through-supabase-oauth-in-a-system-browser-sheet.md), [CUP-60](https://linear.app/cup-audio/issue/CUP-60)); the safe area test with [cup-audio/cup#292](https://github.com/cup-audio/cup/pull/292) and [cup-audio/cup#312](https://github.com/cup-audio/cup/pull/312); the Add sheet wait with [cup-audio/cup#313](https://github.com/cup-audio/cup/issues/313); the external links test with [cup-audio/cup#502](https://github.com/cup-audio/cup/pull/502). These decisions were recorded from code comments on 2026-11-23.

## Decision

- **A share from Safari goes through the More menu** ([iOS app device](../../qa/mobile-e2e/src/ios/ios-app-device.ts)): Safari's compact toolbar has no Share button, and Share sits in its More menu. In that menu, the Share button's icon image is labelled "Share" too, so the predicate asks for an `XCUIElementTypeButton`.
- **The Share Sheet tests depend on Safari's system UI** and fail when an iOS update changes it ([share sheet test](../../qa/mobile-e2e/test/ios/share-sheet.test.ts)). Each share starts Cup; a share that reaches a running Cup takes the same handoff, which the `audio.cup.app://share` link alone covers in [`share.test.ts`](../../qa/mobile-e2e/test/ios/share.test.ts).
- **The `CupShare` extension opens Cup on its own once it has read the page's URL**, so a share from Safari taps More, Share and Cup in the app row and nothing more, and ends once Cup is in the foreground.
- **Sign-in taps Continue on the prompt `ASWebAuthenticationSession` shows before its sheet opens**, "“Cup” Wants to Use “localhost” to Sign In". The sheet then loads the fake auth provider, which redirects to Cup's callback URL at once, and the sheet closes; the device waits for the prompt to go away.
- **Links that leave Cup are checked only by which app is in front** ([external links test](../../qa/mobile-e2e/test/ios/external-links.test.ts)): Capacitor hands every navigation away from Cup's origin to iOS, which opens Safari, and the test Worker's hosts are unreachable from Safari.
- **The safe area test reads the Back link's position in native screen points** ([safe area test](../../qa/mobile-e2e/test/ios/safe-area.test.ts)), which the WebView's own coordinates would not reveal. It scrolls the audiobook page only within its height, because past its end WebKit bounces the whole page back, header included. On Recents it checks that the fixed backdrop spans the top safe area rather than what is drawn there, because WebKit hit-tests nothing under the status bar.
- **The status bar's height is read in screen points from the native context**, where element positions are in screen points too, and the WebView's safe area covers it.
- **Clearing Cup's data reinstalls it and resets the simulator's Keychain**: iOS has no command that clears one app's data, a reinstall erases its container, and the account session is in the Keychain, which outlives a reinstall. Only the run's own simulator's Keychain is reset.
- **After a relaunch the device attaches anew**, since the WebView gets a new context, named after Cup's new process.
- **A native crash runs the Sentry plugin's test hook after the WebDriver script has returned** ([telemetry assertions](../../qa/mobile-e2e/src/telemetry-assertions.ts)): on iOS, Appium otherwise waits two minutes for the answer of a page whose process has died.
- **The Add sheet test waits until the sheet's slide-in has finished before typing** ([native networking test](../../qa/mobile-e2e/test/native-networking.test.ts)): WebKit refuses to type into its URL field until it is in place. Its slide-in animation holds its end state, so it stays listed after it finishes, and the wait looks for the finished animation rather than for it to disappear.

## Consequences

- An iOS update that moves Share, renames its labels or changes the sign-in prompt fails these tests; that is the signal to update them.
- The external links tests cannot check which URL Safari opened.

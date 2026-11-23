---
status: accepted
---

# Register the shells' own plugins and route incoming links through Capacitor

The Android and iOS shells are Capacitor apps that load the web app's build, plus a few native plugins of Cup's own and links that arrive from the system: shared text on Android, the Share Extension's links and universal links on iOS. Capacitor finds npm plugins by itself and delivers incoming URLs through its App plugin, but neither covers Cup's own plugins or a link that cold-starts the app before the web app listens. These choices were made with Android sharing and App Links (commit `fcf27721`), the mobile E2E suite in [cup-audio/cup#211](https://github.com/cup-audio/cup/pull/211), and iOS sign-in through a system browser sheet in [cup-audio/cup#227](https://github.com/cup-audio/cup/pull/227) ([ADR 0019](0019-sign-in-on-ios-through-supabase-oauth-in-a-system-browser-sheet.md), Linear CUP-60). These decisions were recorded from code comments on 2026-11-23.

## Decision

- **Cup's own plugins are registered by hand.** They are not npm packages, so Capacitor does not find them by itself; on iOS the [main view controller](../../apps/mobile-app/ios/App/App/MainViewController.swift) registers them in `capacitorDidLoad`.
- **The iOS app links only the plugins it lists.** [`capacitor.config.ts`](../../apps/mobile-app/capacitor.config.ts) names the iOS plugins in `ios.includePlugins`. iOS signs in through the app's own WebAuthentication plugin, so it links no Google SDK. A new plugin the iOS app needs must be added there too, or `cap sync` leaves it out of the iOS app.
- **iOS adopts the scene lifecycle.** Incoming URLs and universal links arrive at the [scene delegate](../../apps/mobile-app/ios/App/App/SceneDelegate.swift), not the app delegate. It is Cup's only window scene: UIKit creates its window and `MainViewController` from `Main.storyboard`, named in `Info.plist`'s scene manifest. Incoming URLs, such as the Share Extension's `audio.cup.app://share` links, reach Capacitor's App plugin through its proxy, which delivers a cold start's URL once the bridge has loaded its plugins.
- **Android retains a cold-start share** until the web app has registered its listener: the [share plugin](../../apps/mobile-app/android/app/src/main/java/audio/cup/app/AndroidSharePlugin.java) notifies with Capacitor's retain flag.
- **The iOS sign-in session is held by the plugin.** The [web authentication plugin](../../apps/mobile-app/ios/App/App/WebAuthenticationPlugin.swift) keeps the running `ASWebAuthenticationSession`, because the session ends when nothing holds it.

## Consequences

- Adding a native plugin means registering it by hand if it is Cup's own, and listing it in `ios.includePlugins` if iOS needs it.
- A share or link that cold-starts Cup reaches the web app once it listens, on both platforms.

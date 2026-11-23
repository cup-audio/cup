---
status: accepted
---

# Recover from WebView process loss by reloading the web app and reporting it

The shells run the whole web app in one WebView whose content runs in a separate process: Android WebView's renderer process and WKWebView's WebContent process. When that process dies, Android by default ends Cup's whole process with the renderer. Neither platform's loss reaches the web app's own error handling, because the page that would report it is gone. This was decided and built with production error reporting in [cup-audio/cup#422](https://github.com/cup-audio/cup/pull/422) (from [#403](https://github.com/cup-audio/cup/issues/403)). These decisions were recorded from code comments on 2026-11-23; the mobile app README's "WebView process loss" section describes the behaviour.

## Decision

- **Record the loss natively, reload, and let the restarted web app report it.** The native side stores the loss in Cup's own preferences or defaults, and a `WebViewProcessLossPlugin` hands it to the restarted web app, whose `takeWebViewProcessLoss()` of `@cup/telemetry.browser` reports it to Sentry. Taking the loss returns it in the shape that library parses and forgets it.
- **Android** ([`WebViewProcessLoss`](../../apps/mobile-app/android/app/src/main/java/audio/cup/app/WebViewProcessLoss.java), [plugin](../../apps/mobile-app/android/app/src/main/java/audio/cup/app/WebViewProcessLossPlugin.java)): when the renderer process is gone, Cup records it, removes the WebView from the view hierarchy, destroys it, and recreates the activity, so the web app reloads at its start URL. Android's guidance is that a WebView whose renderer is gone must leave the view hierarchy and never be used again; Capacitor's bridge would otherwise keep calling into it. The handler returns that it handled the loss, so Android keeps Cup's process alive. The record is written synchronously, because the recreated activity's web app reads it, and so might a later process.
- **iOS** ([main view controller](../../apps/mobile-app/ios/App/App/MainViewController.swift)): `WebContentTerminationObserver` sits between the WebView and Capacitor's navigation delegate, which Capacitor sets while preparing the WebView, before `capacitorDidLoad`, so the observer is inserted there. It records that the WebContent process terminated and forwards every navigation delegate call, that one included, to Capacitor's delegate, which reloads the page. Selectors the observer does not implement reach Capacitor's delegate through Objective-C message forwarding, so the wrapper keeps working when Capacitor adds a method. The view controller keeps a strong reference to the observer, because the WebView holds its navigation delegate weakly. The loss stays in Cup's own defaults until the reloaded web app takes it.

## Consequences

- A renderer or WebContent process loss costs the listener a reload of the web app, not Cup's whole process.
- The iOS observer depends on Objective-C message forwarding to Capacitor's delegate, so a Capacitor update that changes how it sets the navigation delegate must be rechecked.
- The mobile E2E suite crashes the renderer through a debug-only plugin to check the Android path.

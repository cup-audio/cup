# Telemetry for the browser

Sentry's options, privacy hooks and user rule for the web app, which the Capacitor shells also render, on `@sentry/capacitor` with `@sentry/react`. The [observability page](../../docs/architecture/observability.md#what-the-web-app-sends) describes what the web app sends and why.

## Use

[`createClientSentryOptions({ pageOrigin, apiOrigin, release, router, shell })`](src/client-sentry-options.ts) returns the options for one `Sentry.init(options, SentryReact.init)`, or `undefined` when the client must send nothing; the web app's [`initializeTelemetry`](../../apps/web-app/src/telemetry.ts) calls it. The options send through the telemetry tunnel at `apiOrigin` plus `/_/e`, propagate traces only to `apiOrigin`, and trace through the passed TanStack Router.

The on/off rule:

- In the browser, without `shell`, the client sends only when `pageOrigin` is exactly `https://cup.audio`, as release `release`.
- In a native shell, `shell` says whether it is a debug build, the test DSN it was launched with, and its app version and build. A release shell sends only when `apiOrigin` is exactly `https://cup.audio`, to the `cup-app` DSN. A debug shell sends only with a test DSN, and then only to it. The caller counts a shell that does not say it is a release build as a debug build.
- A shell sends as release `audio.cup.app@<version>+<build>` with `dist` the build, which its native SDK shares, and tags the web release as `cup.web_release`. It turns the native SDK on, with native session tracking and watchdog termination tracking off and threads attached to native events. It also passes `cocoaOptions`, which the workspace's patch of `@sentry/capacitor` forwards on iOS only and applies to the Cocoa SDK: native traces at 1.0 of view controllers with frames tracking only, MetricKit diagnostics without raw payloads, all threads attached, and no SIGTERM reports, C++ exception experiment, screenshots or view hierarchies ([ADR 0030](../../docs/adr/0030-capture-native-crashes-in-the-shells-without-consent-keeping-no-installation-id-on-the-device.md)).

The options include the client `beforeSend` and `beforeBreadcrumb` from [`client-before-send.ts`](src/client-before-send.ts). They keep only the user's ID and null the IP address, remove the device identifiers a native SDK copies onto JS events, mask URLs with `@cup/telemetry.core`, and drop the auth errors of Sentry's Supabase integration. The options also set the masking `beforeSendSpan` and `beforeSendLog` of `@cup/telemetry.core`.

[`clientSupabaseIntegration(client)`](src/supabase-telemetry.ts) is Sentry's Supabase integration without query data. The Supabase client exists only once account auth loads, so add it then with `Sentry.addIntegration`; without a running Sentry, that adds nothing.

[`followAccountSession(session, setUser)`](src/telemetry-user.ts) is the user rule: telemetry's user is `signed-out` until a signed-in listener's opaque account ID has loaded, and `signed-out` again after sign-out. It never sets the auth subject and never unsets the user, because `setUser(null)` would let a native SDK fill in its installation ID.

[`takeWebViewProcessLoss()`](src/webview-process-loss.ts) asks the shell's `WebViewProcessLoss` plugin for the WebView process loss it recorded since the web app last started, checks its shape and forgets it; call it only in a shell. [`webViewProcessLossMessage(loss)`](src/webview-process-loss.ts) is the one event it becomes, for `Sentry.captureMessage(message, context)`: level `error`, the fingerprint `webview-renderer-gone` on Android or `webview-content-terminated` on iOS, and the tags `cup.renderer.cause` and `rendererPriorityAtExit` on Android and `cup.app.state` on both ([WebView process loss](../../apps/mobile-app/README.md#webview-process-loss)).

## Web release

The browser's release is `web@<content hash of the entry chunk>`. [`webReleasePlugin()`](src/web-release.vite.ts), from `@cup/telemetry.browser/vite`, writes it into a `<meta name="cup-release">` of the built `index.html`; the web app's shared Vite configuration adds it. [`readWebRelease(document)`](src/web-release.ts) reads it at runtime, and returns `undefined` under Vite's development server.

## Tests

The unit tests cover the on/off rules of the browser and the shells, the Cocoa options, the client `beforeSend` with the Supabase auth-error drop, the user rule, the WebView process loss event, and the release, by building a small page with Vite. Only this library, the web app and the mobile app, for the native plugin, may depend on the client SDK family ([SDK family check](../../qa/workspace-checks/README.md#sentry-sdk-family-check)); take `@sentry/capacitor` and `@sentry/react` from the `sentry-client` catalog.

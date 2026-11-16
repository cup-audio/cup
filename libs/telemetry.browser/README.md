# Telemetry for the browser

Sentry's options, privacy hooks and user rule for the web app, which the Capacitor shells also render, on `@sentry/capacitor` with `@sentry/react`. The [observability page](../../docs/architecture/observability.md#what-the-web-app-sends) describes what the web app sends and why.

## Use

[`createClientSentryOptions({ pageOrigin, apiOrigin, release, router })`](src/client-sentry-options.ts) returns the options for one `Sentry.init(options, SentryReact.init)`, or `undefined` when the client must send nothing; the web app's [`initializeTelemetry`](../../apps/web-app/src/telemetry.ts) calls it. The on/off rule: the browser sends only when `pageOrigin` is exactly `https://cup.audio`. The shells' origins never are, so the shells send nothing yet. The options send through the telemetry tunnel at `apiOrigin` plus `/_/e`, propagate traces only to `apiOrigin`, and trace through the passed TanStack Router.

The options include the client `beforeSend` and `beforeBreadcrumb` from [`client-before-send.ts`](src/client-before-send.ts). They keep only the user's ID and null the IP address, remove the device identifiers a native SDK copies onto JS events, mask URLs with `@cup/telemetry.core`, and drop the auth errors of Sentry's Supabase integration. The options also set the masking `beforeSendSpan` and `beforeSendLog` of `@cup/telemetry.core`.

[`clientSupabaseIntegration(client)`](src/supabase-telemetry.ts) is Sentry's Supabase integration without query data. The Supabase client exists only once account auth loads, so add it then with `Sentry.addIntegration`; without a running Sentry, that adds nothing.

[`followAccountSession(session, setUser)`](src/telemetry-user.ts) is the user rule: telemetry's user is `signed-out` until a signed-in listener's opaque account ID has loaded, and `signed-out` again after sign-out. It never sets the auth subject and never unsets the user, because `setUser(null)` would let a native SDK fill in its installation ID.

## Web release

The browser's release is `web@<content hash of the entry chunk>`. [`webReleasePlugin()`](src/web-release.vite.ts), from `@cup/telemetry.browser/vite`, writes it into a `<meta name="cup-release">` of the built `index.html`; the web app's shared Vite configuration adds it. [`readWebRelease(document)`](src/web-release.ts) reads it at runtime, and returns `undefined` under Vite's development server.

## Tests

The unit tests cover the on/off rule, the client `beforeSend` with the Supabase auth-error drop, the user rule, and the release, by building a small page with Vite. Only this library and the web app may depend on the client SDK family ([SDK family check](../../qa/workspace-checks/README.md#sentry-sdk-family-check)); take `@sentry/capacitor` and `@sentry/react` from the `sentry-client` catalog.

# Client observability

The web app reports to Sentry's `cup-app` project, in the browser and inside the Android and iOS shells, where Sentry's native SDKs report to the same project. The [observability overview](observability.md) holds the rules every runtime shares: capture, privacy, alerts and why nothing is sent outside production.

## What the web app sends

In the browser on `https://cup.audio`, the web app reports through `@sentry/capacitor` with `@sentry/react`, always through the [telemetry tunnel](#telemetry-tunnel). [`initializeTelemetry`](../../apps/web-app/src/telemetry.ts) starts it with the options of [`@cup/telemetry.browser`](../../libs/telemetry.browser/README.md), whose code lists what is ignored and what stays off; the [web app page](web-app.md#telemetry) describes where it hooks into the app.

- **Errors**: uncaught errors and rejections, render errors, and the failures the web app captures where nothing awaits them. A failed request, a Listener API 5xx included, is only a breadcrumb, since the Worker captured the server failure and the trace ID joins both.
- **Traces** of every page load and navigation, named after the route. Requests to the API origin carry Sentry's trace headers and join the Worker's trace; no other host receives them.
- **Sessions**, one per route, and **logs**, of which the web app writes none yet.
- **The user**: the opaque account ID once signed in, and `signed-out` otherwise, never unset, because an unset user lets a native SDK fill in its installation ID.
- **The release** `web@<hash>`, derived from the bundle's content, so it changes exactly when the bundle's code does ([release tracking](observability-operations.md#release-tracking)).

## What the shells send

The shells run the same web app and the same `initializeTelemetry`, which there also starts Sentry's native SDK, Android's or Cocoa's, through `@sentry/capacitor` ([ADR 0031](../adr/0031-capture-native-crashes-in-the-shells-without-consent-keeping-no-installation-id-on-the-device.md)). The [mobile app guide](../../apps/mobile-app/README.md#sentry) lists the native settings.

- **JS errors, traces and logs** as in the browser, through the telemetry tunnel.
- **[Crash reports](../GLOSSARY.md#crash-report)** go straight from the native SDK to Sentry on the next launch: native crashes on both platforms, ANRs and memory-limiter kills on Android, app hangs and MetricKit diagnostics on iOS. A native crash carries the account ID; ANR and tombstone events, reported from a later process, carry none.
- **Native traces** of activities and view controllers. Because the page starts the native SDK only after the first activity or view controller exists, neither shell sends native app-start spans; this [going-live check](observability-operations.md#going-live-checks) is unresolved.
- **The release** `audio.cup.app@<version>+<build>`, which JS and native events share, with the web bundle's release as the tag `cup.web_release`.
- **[WebView process loss](../GLOSSARY.md#webview-process-loss)**: the shell records the loss natively and brings the page back, and the reloaded web app sends one JS event through the tunnel with a fixed fingerprint per platform, so each platform has one issue ([mobile app guide](../../apps/mobile-app/README.md#webview-process-loss)).

### No installation ID on the device

The native SDKs keep their installation ID in memory only, a new one per process. Native session tracking, Android's scope persistence and NDK, and iOS's watchdog termination tracking are off, so the SDKs keep no installation ID or session on the device, and release health for the shells is given up. A crash report waits on the device, with its scope, only until the next launch sends it. There is no native `beforeSend`: the organisation's scrubbing rule removes the remaining device identifiers at ingest. The [mobile app guide](../../apps/mobile-app/README.md#android-sentry-setup) describes how each platform keeps the ID out of storage.

## Crash reports switch

The shells' account settings have a "Send crash reports" switch, on by default; the browser has none. It turns [crash reports](../GLOSSARY.md#crash-report) off, not the shell's JS errors, traces and logs. The shell stores the switch natively, never in `localStorage`, and `initializeTelemetry` reads it before starting Sentry. Turning it off deletes Sentry's files on the device, but the running native SDK keeps running until the app stops: the switch takes full effect on the next start, which runs JS-only and deletes whatever that SDK wrote meanwhile. Crashes of listeners who turned it off reach only the store consoles. The [mobile app guide](../../apps/mobile-app/README.md#crash-reports-switch) describes the plugin and the files.

## Telemetry tunnel

The [telemetry tunnel](../GLOSSARY.md#telemetry-tunnel) carries all client JS telemetry through Cup's own domain, so blockers of Sentry's hosts do not drop it. The [API server](../../libs/api-server/src/api-server.ts) serves it at `POST /_/e`, outside `/api/*` and the Listener API contract, without authentication; the path avoids "sentry" so filter lists don't match it. It answers CORS for the shells' origins without credentials. Its [handler](../../libs/telemetry.cloudflare/README.md#telemetry-tunnel) rewrites each envelope before forwarding it:

- **No open proxy.** It forwards only envelopes for a DSN on the Worker's `SENTRY_TUNNEL_DSNS` allowlist, in production exactly the `cup-app` DSN, and refuses every other, the Worker's own included.
- **Country, not IP address.** It removes the headers that carry the listener's IP address and stamps the country from Cloudflare onto events and transactions, replacing any location the client sent.

The tunnel has no rate limit of its own: the DSN is public anyway, and Sentry's quota and spike protection cap abuse.

## On or off

The web app decides at runtime, by the rule of [`@cup/telemetry.browser`](../../libs/telemetry.browser/README.md#use), because every web E2E suite runs the production bundle:

- the browser sends only when the page's origin is exactly `https://cup.audio`, so local development, the component tests and the E2E suites start no Sentry at all;
- a release shell sends only when its API origin is `https://cup.audio`;
- a debug shell sends nothing unless the [mobile E2E suite](../../qa/mobile-e2e/README.md#telemetry) launches it with a Sentry stub's DSN, and then only to that DSN; a shell that does not say it is a release build counts as a debug build.

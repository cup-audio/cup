---
status: accepted
---

# Start Sentry in the web app only in production and bridge it to the native SDK

[ADR 0030](0030-observe-production-with-sentrys-own-sdks-and-turn-cloudflares-observability-off.md) chose Sentry's own SDKs, and [ADR 0031](0031-capture-native-crashes-in-the-shells-without-consent-keeping-no-installation-id-on-the-device.md) native crash capture in the shells with a "Send crash reports" switch. The web app runs in a browser and inside both shells, where the Capacitor SDK starts the browser SDK next to a native SDK, so how and when Sentry starts in the web app needed rules of its own. [cup-audio/cup#422](https://github.com/cup-audio/cup/pull/422) (issue [cup-audio/cup#403](https://github.com/cup-audio/cup/issues/403)) implemented them, and [cup-audio/cup#211](https://github.com/cup-audio/cup/pull/211) (CUP-60) added the debug shell's test origin. These decisions were recorded from code comments on 2026-11-23.

## Decision

- **Production only.** [`initializeTelemetry`](../../apps/web-app/src/telemetry.ts) does nothing outside production: the browser sends only from `https://cup.audio`, a release shell only against it, and a debug shell only to the test DSN the mobile E2E suite passed it. It runs once, right after the router exists and before the platform listeners start, so their failures are captured. If starting it fails, telemetry is off, so the failure goes to `reportError`, where the browser reports errors ([bootstrap](../../apps/web-app/src/bootstrap.tsx)).
- **Debug shell overrides.** Only the debug build of a native shell that the mobile E2E suite launched sets the Sentry stub's DSN and the test Worker's [API origin](../../apps/web-app/src/platform/api-origin.ts) before the page loads; release builds never set them.
- **Release detection.** Only an explicit `false` from the native side's `Capacitor.DEBUG` counts as a release build.
- **Crash reports switch.** The switch is read before `Sentry.init`, which decides `enableNative`, so turning it off takes effect on the next start ([crash reporting](../../apps/web-app/src/platform/crash-reporting.ts)). Off deletes the native SDK's files at once, and the next start runs Sentry JS-only; the native SDK of the running process keeps running until then.
- **Native start.** The Capacitor SDK starts the browser SDK once the native SDK runs, or has failed to start. The current user is set again once the native SDK runs: a user set before then never reached the native scope, and scope sync copies only later changes.
- **User.** Telemetry's user follows the account session by the user rule of `@cup/telemetry.browser`. The account ID is loaded with `requestApi`, not through the query cache, so the account settings still load a fresh snapshot.
- **WebView process loss.** In a shell, the web app reports once a WebView process loss that the native side recorded before it brought the page back; this is the first moment the event can be sent, through the tunnel like every JS event. The record is taken even when telemetry stays off, so a loss is never reported in a later start.
- **React errors.** Sentry captures what React reports, then hands it on to `reportError`, React's own default, so the browser still shows it; Sentry skips the error it already captured when the global handler sees it.
- **Source maps.** The build writes hidden source maps, and `prepare-source-maps` in `turbo:build` moves them out of what is served and packed ([Vite config](../../apps/web-app/vite.config.ts)).

## Consequences

- No development, preview or test run sends to the real Sentry.
- Turning crash reports off never stops the running native SDK; the listener's choice applies from the next start.
- A WebView process loss is sent at most once, on the start that follows it.

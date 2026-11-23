---
status: accepted
---

# Reach the host's test servers from the app at localhost

Each mobile E2E test starts its own test Worker, fake auth provider and, for telemetry tests, Sentry stub on the Mac, on ports the operating system assigns ([ADR 0018](0018-test-the-mobile-apps-with-appium-through-webdriverio-on-host-owned-emulators-and-simulators.md)). The app on the emulator or simulator has to reach them, and the debug build allows plain HTTP only to `localhost`. The approach landed with the suite in [cup-audio/cup#211](https://github.com/cup-audio/cup/pull/211); the Sentry stub joined in [cup-audio/cup#422](https://github.com/cup-audio/cup/pull/422) ([cup-audio/cup#403](https://github.com/cup-audio/cup/issues/403)). These decisions were recorded from code comments on 2026-11-23.

## Decision

- **The app always gets `http://localhost:<port>`** as the test Worker's origin ([app device](../../qa/mobile-e2e/src/app-device.ts), [fixtures](../../qa/mobile-e2e/src/fixtures.ts)); both platforms map `localhost` to the host's loopback.
- **`exposeHostPort` makes a host port reachable at `localhost:<port>` from the app, and returns false, exposing nothing, when that port is already taken on the device's side**, so the caller needs another one. The fixture tries five ports: a taken port is rare, and five in a row means something is wrong.
- **On Android, a port the device already holds counts as taken**: adbd listens on every address of the emulator, so any socket there holding the port blocks `adb reverse`, and Google Play services' connections and TIME_WAIT sockets use ports the host assigns too. The fixture's `startExposed` then starts the server again on another port the host's operating system assigns; this picks a port and repeats no test step.
- **The fake auth provider's origin, and with it the issuer of the tokens it signs, is `http://localhost:<port>`**, as both the app and the Worker see it.
- **The Sentry stub and the test Worker that forwards to it listen on the host's `127.0.0.1`.** The app reaches the stub's `cup-app` DSN through the exposed port; JS events go through the test Worker's telemetry tunnel, while the native SDKs send straight to the stub.
- **On iOS, the simulator shares the host's loopback, so only `::1` needs a relay** ([loopback relay](../../qa/mobile-e2e/src/ios/loopback-relay.ts)). The simulator connects to `localhost` over `::1` first, falling back to `127.0.0.1` only when nothing listens on `::1`. The test Worker listens on `127.0.0.1` alone, so without the relay another process holding the same port on `::1` would receive the app's requests. The relay forwards `[::1]:<port>` to `127.0.0.1:<port>` unless this process already listens there (the fake auth provider listens on both loopbacks itself), and the port counts as taken when another process listens on `[::1]:<port>`.
- **The page Safari opens and shares in the iOS Share Sheet tests is served on `127.0.0.1`** at a port the operating system assigns ([shared page](../../qa/mobile-e2e/src/ios/shared-page.ts)), so a share needs no internet; an IP address leaves Safari no `::1` to try first.

## Consequences

- A test that adds a server for the app must expose its port through `exposeHostPort` and handle a taken port.
- On iOS, a server that listens only on `::1` or on another interface is not reachable through the relay.

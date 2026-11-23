---
status: accepted
---

# Check the host's toolchain before a run and fail rather than skip

The mobile E2E suite runs on the developer's Mac with Android Studio, Java 21 and Xcode ([ADR 0018](0018-test-the-mobile-apps-with-appium-through-webdriverio-on-host-owned-emulators-and-simulators.md): a preflight check names what is missing). A missing or mismatched tool used to surface as a hang minutes into a run. The preflight checks landed with the suite in [cup-audio/cup#211](https://github.com/cup-audio/cup/pull/211). These decisions were recorded from code comments on 2026-11-23.

## Decision

- **Each platform's preflight runs before any device starts and fails the run with every problem and its fix, rather than skipping the platform** ([Android preflight](../../qa/mobile-e2e/src/android/preflight.ts), [iOS preflight](../../qa/mobile-e2e/src/ios/preflight.ts)). `pnpm --filter @cup/mobile-e2e preflight` runs both checks without starting a run; each platform's global setup runs its own check again.
- **The Java check reads `java -version` from stderr**, where `java` writes it.
- **The toolchain key reads Java's settings and version from stderr too** (`java -XshowSettings:properties -version`).
- **Since version 26, Xcode's major version must be at least macOS's.** Xcode and macOS share major versions, and an older Xcode's XCTest runners hang on a newer macOS: WebDriverAgent never answers and the session times out after minutes. The iOS preflight fails on such an Xcode and names the fix, updating Xcode and restarting CoreSimulatorService.
- **The iOS run uses the simulator runtime of the same version as Xcode's simulator SDK, rather than the newest one installed**, by its plain identifier, such as `com.apple.CoreSimulator.SimRuntime.iOS-27-2`; device-specific runtimes of that version carry a suffix and are skipped. An older runtime on a newer macOS is not enough: on macOS 27.2, WebKit's content process crashed under the iOS 26.3.1 runtime in about one launch in seven.
- **After an Xcode update the running CoreSimulatorService is older than `simctl`**, which then warns about the version mismatch and lists no runtimes; the preflight recognizes the warning and names the restart.
- **The toolchain key's unit test points `DEVELOPER_DIR` at a missing folder** ([toolchain key test](../../qa/mobile-e2e/test-unit/toolchain-key.test.ts)) to keep the CLI's iOS probes off the host's Xcode, which it does not check: `xcrun simctl` starts CoreSimulatorService when it is not running, which took the test past its timeout on a loaded Mac.
- **Xcode's build version is part of what the iOS run needs**, because a new Xcode needs a new WebDriverAgent build.
- **Each run builds the debug app afresh**, so a run never tests a stale build ([iOS build](../../qa/mobile-e2e/src/ios/build.ts)). Simulator builds need no development team; Xcode signs them ad hoc.

## Consequences

- A Mac without one platform's toolchain fails that platform's run instead of passing it silently.
- After a macOS major update, the iOS run fails until Xcode catches up.

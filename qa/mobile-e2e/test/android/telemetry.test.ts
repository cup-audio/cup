import { expect, test } from "vitest";

import type { SentryErrorEvent } from "@cup/sentry-stub";

import { asAndroidAppDevice, type AndroidAppDevice } from "#src/android/android-app-device.ts";
import { useMobileApp } from "#src/fixtures.ts";
import { signInFromHomeLink } from "#src/journeys.ts";
import {
  crashNatively,
  distinctEvents,
  expectJsErrorThroughTunnel,
  hasException,
  readAccountId,
  SENTRY_EVENT_TIMEOUT_MS,
} from "#src/telemetry-assertions.ts";

/**
 * The Android shell's telemetry against the test's Sentry stub: the debug build reports only
 * because the suite passes it the stub's DSN. JS events go through the test Worker's telemetry
 * tunnel; the native SDK sends straight to the stub, which `adb reverse` makes reachable.
 */
const app = useMobileApp({ sentryStub: true });

/** What `SentryCapacitor.crash()` throws on the plugin's thread, which kills Cup. */
const NATIVE_CRASH_MESSAGE = "TEST - Sentry Client Crash";

test("a shell JS error and a native crash arrive with the account ID, and no installation ID outlives a launch", async () => {
  const device = asAndroidAppDevice(app.device);
  await device.launch({ apiOrigin: app.apiOrigin, testSentryDsn: app.testSentryDsn });
  let webView = await device.webView();
  await signInFromHomeLink(device, webView);
  const accountId = await readAccountId(app);

  // A JS error once the user rule applied the account ID; it also tells that the native scope has
  // the user.
  await expectJsErrorThroughTunnel(app, webView, accountId);

  const firstCrash = await crashAndRelaunch(device, webView, 1);
  expect(firstCrash.user?.["id"]).toBe(accountId);
  expect(firstCrash).toMatchObject({
    level: "fatal",
    release: expect.stringMatching(/^audio\.cup\.app@/),
  });
  // The native SDK with sentry-native never registered its NDK integration.
  expect(sdkIntegrations(firstCrash)).not.toContain("Ndk");

  webView = await device.webView();
  const secondCrash = await crashAndRelaunch(device, webView, 2);
  // The stub still sees the device ID, which the organisation's scrubbing rule removes at ingest.
  const firstDeviceId = firstCrash.contexts?.["device"]?.["id"];
  const secondDeviceId = secondCrash.contexts?.["device"]?.["id"];
  expect(firstDeviceId).toMatch(/^[0-9a-f]{32}$/);
  expect(secondDeviceId).toMatch(/^[0-9a-f]{32}$/);
  expect(secondDeviceId).not.toBe(firstDeviceId);

  const storedPaths = await device.appDataPaths();
  expect(storedPaths.filter((path) => /\/INSTALLATION$|\.sentry-native/.test(path))).toEqual([]);
});

/**
 * Crashes Cup natively on the Capacitor plugin thread, launches it again, which sends a crash left
 * on disk at the latest, and returns the `count`th native crash event the stub received.
 */
async function crashAndRelaunch(
  device: AndroidAppDevice,
  webView: WebdriverIO.Browser,
  count: number,
): Promise<SentryErrorEvent> {
  // The SDK's own test hook throws on the plugin thread, where nothing catches it.
  await crashNatively(webView);
  // Sentry's crash handler sends the crash, or stores it, before Android ends the process; a launch
  // that force-stopped Cup sooner would cut that short.
  await device.waitForProcessExit();
  await device.launch({ apiOrigin: app.apiOrigin, testSentryDsn: app.testSentryDsn });
  await app.sentryStub.waitFor(`native crash ${count}`, () => nativeCrashes().length >= count, {
    timeoutMs: SENTRY_EVENT_TIMEOUT_MS,
  });
  const crash = nativeCrashes()[count - 1];
  if (crash === undefined) {
    throw new Error(`Native crash ${count} is missing.`);
  }
  return crash;
}

function nativeCrashes(): SentryErrorEvent[] {
  return distinctEvents(
    app.sentryStub
      .errorEvents("cup-app")
      .filter((event) => event["platform"] === "java" && hasException(event, NATIVE_CRASH_MESSAGE)),
  );
}

function sdkIntegrations(event: SentryErrorEvent): unknown {
  const sdk = event["sdk"];
  return typeof sdk === "object" && sdk !== null ? Reflect.get(sdk, "integrations") : undefined;
}

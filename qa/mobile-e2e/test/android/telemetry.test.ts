import { expect, test } from "vitest";

import type { SentryErrorEvent } from "@cup/sentry-stub";

import { asAndroidAppDevice, type AndroidAppDevice } from "#src/android/android-app-device.ts";
import { useMobileApp } from "#src/fixtures.ts";
import { signInFromHomeLink } from "#src/journeys.ts";

/**
 * The Android shell's telemetry against the test's Sentry stub: the debug build reports only
 * because the suite passes it the stub's DSN. JS events go through the test Worker's telemetry
 * tunnel; the native SDK sends straight to the stub, which `adb reverse` makes reachable.
 */
const app = useMobileApp({ sentryStub: true });

/** What `SentryCapacitor.crash()` throws on the plugin's thread, which kills Cup. */
const NATIVE_CRASH_MESSAGE = "TEST - Sentry Client Crash";
/** The headers that would carry the device's IP address to Sentry. */
const CLIENT_IP_HEADERS = [
  "cf-connecting-ip",
  "x-forwarded-for",
  "x-real-ip",
  "x-sentry-forwarded-for",
];
const NATIVE_EVENT_TIMEOUT_MS = 30_000;

/** The part of the page's `window.Capacitor` the test calls. */
type SentryCapacitorGlobal = { Plugins: { SentryCapacitor: { crash(): Promise<void> } } };

test("a shell JS error and a native crash arrive with the account ID, and no installation ID outlives a launch", async () => {
  const device = asAndroidAppDevice(app.device);
  await device.launch({ apiOrigin: app.apiOrigin, testSentryDsn: app.testSentryDsn });
  let webView = await device.webView();
  await signInFromHomeLink(device, webView);
  const accountId = await readAccountId();

  // A JS error once the user rule applied the account ID: it went through the tunnel, which
  // strips the client's IP headers, and it tells that the native scope has the user too.
  const jsErrorMessage = "mobile-e2e shell JS error";
  await webView.execute((message) => {
    setTimeout(() => {
      throw new Error(message);
    });
  }, jsErrorMessage);
  await app.sentryStub.waitFor(
    "the shell's JS error with the account ID",
    () =>
      app.sentryStub
        .errorEvents("cup-app")
        .some((event) => hasException(event, jsErrorMessage) && event.user?.["id"] === accountId),
    { timeoutMs: NATIVE_EVENT_TIMEOUT_MS },
  );
  const jsEvent = app.sentryStub
    .errorEvents("cup-app")
    .find((event) => hasException(event, jsErrorMessage));
  const jsEnvelope = app.sentryStub.envelopes.find(
    ({ header }) => header["event_id"] === jsEvent?.event_id,
  );
  expect(jsEnvelope).toBeDefined();
  for (const header of CLIENT_IP_HEADERS) {
    expect(jsEnvelope?.requestHeaders).not.toHaveProperty(header);
  }
  expect(app.worker.requests()).toContainEqual(
    expect.objectContaining({ method: "POST", path: "/_/e" }),
  );

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
  await webView.execute(() => {
    // The SDK's own test hook: it throws on the plugin thread, where nothing catches it.
    const capacitor: SentryCapacitorGlobal = Reflect.get(window, "Capacitor");
    void capacitor.Plugins.SentryCapacitor.crash();
  });
  // Sentry's crash handler sends the crash, or stores it, before Android ends the process; a launch
  // that force-stopped Cup sooner would cut that short.
  await device.waitForProcessExit();
  await device.launch({ apiOrigin: app.apiOrigin, testSentryDsn: app.testSentryDsn });
  await app.sentryStub.waitFor(`native crash ${count}`, () => nativeCrashes().length >= count, {
    timeoutMs: NATIVE_EVENT_TIMEOUT_MS,
  });
  const crash = nativeCrashes()[count - 1];
  if (crash === undefined) {
    throw new Error(`Native crash ${count} is missing.`);
  }
  return crash;
}

function nativeCrashes(): SentryErrorEvent[] {
  return app.sentryStub
    .errorEvents("cup-app")
    .filter((event) => event["platform"] === "java" && hasException(event, NATIVE_CRASH_MESSAGE));
}

/** The account ID of the signed-in listener, read from the test Worker with the app's token. */
async function readAccountId(): Promise<string> {
  const authorization = app.worker
    .requests()
    .findLast(({ headers }) => headers["authorization"]?.startsWith("Bearer ") === true)?.headers[
    "authorization"
  ];
  if (authorization === undefined) {
    throw new Error("The app sent no request with a bearer token.");
  }
  const response = await fetch(`${app.worker.origin}/api/account`, {
    headers: { authorization },
  });
  const body: unknown = await response.json();
  const accountId: unknown =
    typeof body === "object" && body !== null ? Reflect.get(body, "accountId") : undefined;
  if (!response.ok || typeof accountId !== "string") {
    throw new Error(`Reading the account failed with ${response.status}.`);
  }
  return accountId;
}

function hasException(event: SentryErrorEvent, message: string): boolean {
  return (event.exception?.values ?? []).some(({ value }) => value?.includes(message) === true);
}

function sdkIntegrations(event: SentryErrorEvent): unknown {
  const sdk = event["sdk"];
  return typeof sdk === "object" && sdk !== null ? Reflect.get(sdk, "integrations") : undefined;
}

import { expect, test } from "vitest";

import type { SentryErrorEvent } from "@cup/sentry-stub";

import { asAndroidAppDevice, type AndroidAppDevice } from "#src/android/android-app-device.ts";
import { useMobileApp } from "#src/fixtures.ts";
import { signInFromHomeLink, waitForRecents } from "#src/journeys.ts";
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

test("a renderer crash brings Cup back on Recents and reaches the stub through the tunnel", async () => {
  const device = asAndroidAppDevice(app.device);
  await device.launch({ apiOrigin: app.apiOrigin, testSentryDsn: app.testSentryDsn });
  let webView = await device.webView();
  await signInFromHomeLink(device, webView);
  const processId = await device.processId();

  // The debug build's hook loads `chrome://crash` once the script has returned, so the answer
  // does not wait on the dying page.
  await webView.execute(() => {
    setTimeout(() => {
      const capacitor: RendererCrashGlobal = Reflect.get(window, "Capacitor");
      void capacitor.Plugins.CupTestRendererCrash.crash();
    }, 100);
  });

  await app.sentryStub.waitFor("the renderer-gone event", () => rendererGoneEvents().length > 0, {
    timeoutMs: SENTRY_EVENT_TIMEOUT_MS,
  });
  webView = await attachToRecreatedWebView(device);
  await waitForRecents(webView, 0);
  // The same process: Cup recreated its activity instead of Android ending the app.
  expect(await device.processId()).toBe(processId);
  expect(await device.appState()).toBe("foreground");

  expect(rendererGoneEvents()).toHaveLength(1);
  expect(rendererGoneEvents()[0]).toMatchObject({
    level: "error",
    // A JS event, which reaches the stub only through the telemetry tunnel.
    platform: "javascript",
    tags: { "cup.renderer.cause": "crash", "cup.app.state": "foreground" },
  });
  expect(rendererGoneEvents()[0]?.tags?.["rendererPriorityAtExit"]).toMatch(
    /^(waived|bound|important)$/,
  );
  expect(app.worker.requests()).toContainEqual(
    expect.objectContaining({ method: "POST", path: "/_/e" }),
  );
});

/**
 * Attaches to the WebView of the recreated activity. It lives in the same process as the dead one,
 * so Chromedriver keeps its session and stays on the dead page's closed window until it switches.
 */
async function attachToRecreatedWebView(device: AndroidAppDevice): Promise<WebdriverIO.Browser> {
  const webView = await device.webView();
  await webView.waitUntil(
    async () => {
      const handles = await webView.getWindowHandles();
      const newest = handles.at(-1);
      if (newest === undefined) {
        return false;
      }
      await webView.switchToWindow(newest);
      return true;
    },
    { timeout: 30_000, timeoutMsg: "The recreated WebView has no window." },
  );
  return webView;
}

/** The part of the page's `window.Capacitor` the renderer crash calls: the debug build's hook. */
type RendererCrashGlobal = { Plugins: { CupTestRendererCrash: { crash(): Promise<void> } } };

function rendererGoneEvents(): SentryErrorEvent[] {
  return distinctEvents(
    app.sentryStub
      .errorEvents("cup-app")
      .filter(
        ({ fingerprint }) =>
          Array.isArray(fingerprint) && fingerprint.includes("webview-renderer-gone"),
      ),
  );
}

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

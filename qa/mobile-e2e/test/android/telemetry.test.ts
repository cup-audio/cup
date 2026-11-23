import { expect, test } from "vitest";

import type { SentryErrorEvent } from "@cup/sentry-stub";

import { asAndroidAppDevice, type AndroidAppDevice } from "#src/android/android-app-device.ts";
import { useMobileApp } from "#src/fixtures.ts";
import { signInFromHomeLink, waitForRecents } from "#src/journeys.ts";
import {
  crashNatively,
  distinctEvents,
  expectJsErrorThroughTunnel,
  expectNoNativeEvents,
  hasException,
  readAccountId,
  SENTRY_EVENT_TIMEOUT_MS,
  turnCrashReportsOff,
} from "#src/telemetry-assertions.ts";

const app = useMobileApp({ sentryStub: true });

const NATIVE_CRASH_MESSAGE = "TEST - Sentry Client Crash";

test("a shell JS error and a native crash arrive with the account ID, and no installation ID outlives a launch", async () => {
  const device = asAndroidAppDevice(app.device);
  await device.launch({ apiOrigin: app.apiOrigin, testSentryDsn: app.testSentryDsn });
  let webView = await device.webView();
  await signInFromHomeLink(device, webView);
  const accountId = await readAccountId(app);

  await expectJsErrorThroughTunnel(app, webView, accountId);

  const firstCrash = await crashAndRelaunch(device, webView, 1);
  expect(firstCrash.user?.["id"]).toBe(accountId);
  expect(firstCrash).toMatchObject({
    level: "fatal",
    release: expect.stringMatching(/^audio\.cup\.app@/),
  });
  expect(sdkIntegrations(firstCrash)).not.toContain("Ndk");

  webView = await device.webView();
  const secondCrash = await crashAndRelaunch(device, webView, 2);
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
  expect(await device.processId()).toBe(processId);
  expect(await device.appState()).toBe("foreground");

  expect(rendererGoneEvents()).toHaveLength(1);
  expect(rendererGoneEvents()[0]).toMatchObject({
    level: "error",
    platform: "javascript",
    tags: { "cup.renderer.cause": "crash", "cup.app.state": "foreground" },
  });
  expect(rendererGoneEvents()[0]?.tags?.["cup.renderer.priority_at_exit"]).toMatch(
    /^(waived|bound|important)$/,
  );
  expect(app.worker.requests()).toContainEqual(
    expect.objectContaining({ method: "POST", path: "/_/e" }),
  );
});

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

test("after turning crash reports off and restarting, a native crash sends nothing and Sentry's files are gone", async () => {
  const device = asAndroidAppDevice(app.device);
  await device.launch({ apiOrigin: app.apiOrigin, testSentryDsn: app.testSentryDsn });
  let webView = await device.webView();
  await signInFromHomeLink(device, webView);
  const accountId = await readAccountId(app);
  await webView.waitUntil(async () => (await sentryPaths(device)).length > 0, {
    timeout: SENTRY_EVENT_TIMEOUT_MS,
    timeoutMsg: "The native Sentry SDK created no files.",
  });

  await turnCrashReportsOff(webView);
  await device.relaunch();
  webView = await device.webView();
  expect(await sentryPaths(device)).toEqual([]);

  const eventCountBeforeCrash = app.sentryStub.errorEvents("cup-app").length;
  await expectJsErrorThroughTunnel(app, webView, accountId);
  await crashNatively(webView);
  await device.waitForProcessExit();
  await device.launch({ apiOrigin: app.apiOrigin, testSentryDsn: app.testSentryDsn });
  webView = await device.webView();

  await expectNoNativeEvents(app, webView, accountId, eventCountBeforeCrash);
  expect(await sentryPaths(device)).toEqual([]);
});

async function sentryPaths(device: AndroidAppDevice): Promise<string[]> {
  return (await device.appDataPaths()).filter((path) => /^\.\/cache\/sentry(\/|$)/.test(path));
}

async function crashAndRelaunch(
  device: AndroidAppDevice,
  webView: WebdriverIO.Browser,
  count: number,
): Promise<SentryErrorEvent> {
  await crashNatively(webView);
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

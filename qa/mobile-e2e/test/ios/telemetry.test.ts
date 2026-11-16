import fs from "node:fs/promises";
import path from "node:path";
import { expect, test } from "vitest";

import type { SentryErrorEvent } from "@cup/sentry-stub";

import { useMobileApp } from "#src/fixtures.ts";
import { asIosAppDevice, type IosAppDevice } from "#src/ios/ios-app-device.ts";
import { signInFromHomeLink } from "#src/journeys.ts";
import {
  crashNatively,
  distinctEvents,
  expectJsErrorThroughTunnel,
  expectNoNativeEvents,
  readAccountId,
  SENTRY_EVENT_TIMEOUT_MS,
  turnCrashReportsOff,
} from "#src/telemetry-assertions.ts";

/**
 * The iOS shell's telemetry against the test's Sentry stub: the debug build reports only because
 * the suite passes it the stub's DSN. JS events go through the test Worker's telemetry tunnel; the
 * native SDK sends straight to the stub on the host's 127.0.0.1, which the simulator shares.
 */
const app = useMobileApp({ sentryStub: true });

/** The part of the Sentry plugin the test calls to read the Cocoa SDK's installation ID. */
type SentryCapacitorPlugin = {
  setUser(user: Record<string, never>): Promise<void>;
  fetchNativeDeviceContexts(): Promise<{ user?: { id?: unknown } }>;
};

test("a shell JS error and a native crash arrive with the account ID, and no installation ID outlives a launch", async () => {
  const device = asIosAppDevice(app.device);
  await device.launch({ apiOrigin: app.apiOrigin, testSentryDsn: app.testSentryDsn });
  let webView = await device.webView();
  await signInFromHomeLink(device, webView);
  const accountId = await readAccountId(app);

  // A JS error once the user rule applied the account ID.
  await expectJsErrorThroughTunnel(app, webView, accountId);

  const firstCrash = await crashAndRelaunch(device, webView, 1);
  expect(firstCrash.user?.["id"]).toBe(accountId);
  expect(firstCrash).toMatchObject({
    level: "fatal",
    release: expect.stringMatching(/^audio\.cup\.app@/),
  });

  // The relaunched Cup is still signed in; the web app applies its user to the native scope again
  // once the native SDK runs.
  webView = await device.webView();
  const secondCrash = await crashAndRelaunch(device, webView, 2);
  expect(secondCrash.user?.["id"]).toBe(accountId);
  // Cocoa sends its installation ID only as the user of an event without one, and no device ID.
  for (const crash of [firstCrash, secondCrash]) {
    expect(crash.contexts?.["device"]).not.toHaveProperty("id");
  }

  // The installation ID each launch holds in memory, which the next launch does not find.
  const firstInstallationId = await readInstallationId(await device.webView());
  const envelopeCount = app.sentryStub.envelopes.length;
  await device.relaunch();
  // The browser SDK starts once the native SDK runs, and then sends its session.
  await app.sentryStub.waitFor(
    "an envelope from the relaunched Cup",
    () => app.sentryStub.envelopes.length > envelopeCount,
    { timeoutMs: SENTRY_EVENT_TIMEOUT_MS },
  );
  const secondInstallationId = await readInstallationId(await device.webView());
  expect(secondInstallationId).not.toBe(firstInstallationId);

  // Where the Sentry SDK would keep its installation ID, a directory blocks the file, and no file
  // in Cup's data container holds either ID.
  const dataContainer = await device.dataContainerPath();
  const installation = path.join(dataContainer, "Library/Caches/INSTALLATION");
  expect((await fs.stat(installation)).isDirectory()).toBe(true);
  expect(await fs.readdir(installation)).toEqual([]);
  expect(await filesContaining(dataContainer, [firstInstallationId, secondInstallationId])).toEqual(
    [],
  );
});

test("after turning crash reports off and restarting, a native crash sends nothing and Sentry's files are gone", async () => {
  const device = asIosAppDevice(app.device);
  await device.launch({ apiOrigin: app.apiOrigin, testSentryDsn: app.testSentryDsn });
  let webView = await device.webView();
  await signInFromHomeLink(device, webView);
  const accountId = await readAccountId(app);
  // The native SDK, on by default, has created its files.
  await webView.waitUntil(async () => (await sentryPaths(device)).length > 0, {
    timeout: SENTRY_EVENT_TIMEOUT_MS,
    timeoutMsg: "The native Sentry SDK created no files.",
  });

  await turnCrashReportsOff(webView);
  await device.relaunch();
  webView = await device.webView();
  // The relaunch deleted whatever the native SDK of the earlier process wrote after the switch.
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

/**
 * Which of the Cocoa SDK's files exist in `Library/Caches`: its envelopes and scope, its crash
 * reports, and its crash handler's log.
 */
async function sentryPaths(device: IosAppDevice): Promise<string[]> {
  const caches = path.join(await device.dataContainerPath(), "Library/Caches");
  const names = await fs.readdir(caches);
  return names.filter((name) => ["io.sentry", "SentryCrash", "async.log"].includes(name));
}

/**
 * Crashes Cup natively, waits until its process has ended, launches it again, which sends the crash
 * report Sentry's crash handler wrote, and returns the `count`th native crash event the stub
 * received.
 */
async function crashAndRelaunch(
  device: IosAppDevice,
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

/** The fatal events of the Cocoa SDK, which reports a crash on the launch after it. */
function nativeCrashes(): SentryErrorEvent[] {
  return distinctEvents(
    app.sentryStub
      .errorEvents("cup-app")
      .filter((event) => event["platform"] === "cocoa" && event.level === "fatal"),
  );
}

/**
 * The Cocoa SDK's installation ID of the running process. The Sentry plugin reports it as the user
 * of the native scope when the scope has none, so the test unsets the native user first; the launch
 * sends nothing after that.
 */
async function readInstallationId(webView: WebdriverIO.Browser): Promise<string> {
  // An async script waits for its promise only as long as the session's script timeout.
  await webView.setTimeout({ script: 10_000 });
  const id: unknown = await webView.execute(async () => {
    const capacitor: { Plugins: { SentryCapacitor: SentryCapacitorPlugin } } = Reflect.get(
      window,
      "Capacitor",
    );
    const plugin = capacitor.Plugins.SentryCapacitor;
    await plugin.setUser({});
    const contexts = await plugin.fetchNativeDeviceContexts();
    return contexts.user?.id;
  });
  if (typeof id !== "string" || id === "") {
    throw new Error(`The Cocoa SDK reported no installation ID: ${String(id)}`);
  }
  return id;
}

/** The paths of the files under `folder` whose content includes any of `needles`. */
async function filesContaining(folder: string, needles: string[]): Promise<string[]> {
  const entries = await fs.readdir(folder, { recursive: true, withFileTypes: true });
  const matches: string[] = [];
  for (const entry of entries) {
    if (!entry.isFile()) {
      continue;
    }
    const filePath = path.join(entry.parentPath, entry.name);
    const content = await fs.readFile(filePath, "latin1");
    if (needles.some((needle) => content.includes(needle))) {
      matches.push(filePath);
    }
  }
  return matches;
}

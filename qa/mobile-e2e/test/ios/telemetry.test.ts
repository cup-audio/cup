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

const app = useMobileApp({ sentryStub: true });

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

  await expectJsErrorThroughTunnel(app, webView, accountId);

  const firstCrash = await crashAndRelaunch(device, webView, 1);
  expect(firstCrash.user?.["id"]).toBe(accountId);
  expect(firstCrash).toMatchObject({
    level: "fatal",
    release: expect.stringMatching(/^audio\.cup\.app@/),
  });

  webView = await device.webView();
  const secondCrash = await crashAndRelaunch(device, webView, 2);
  expect(secondCrash.user?.["id"]).toBe(accountId);
  for (const crash of [firstCrash, secondCrash]) {
    expect(crash.contexts?.["device"]).not.toHaveProperty("id");
  }

  const firstInstallationId = await readInstallationId(await device.webView());
  const envelopeCount = app.sentryStub.envelopes.length;
  await device.relaunch();
  await app.sentryStub.waitFor(
    "an envelope from the relaunched Cup",
    () => app.sentryStub.envelopes.length > envelopeCount,
    { timeoutMs: SENTRY_EVENT_TIMEOUT_MS },
  );
  const secondInstallationId = await readInstallationId(await device.webView());
  expect(secondInstallationId).not.toBe(firstInstallationId);

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

async function sentryPaths(device: IosAppDevice): Promise<string[]> {
  const caches = path.join(await device.dataContainerPath(), "Library/Caches");
  const names = await fs.readdir(caches);
  return names.filter((name) => ["io.sentry", "SentryCrash", "async.log"].includes(name));
}

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

function nativeCrashes(): SentryErrorEvent[] {
  return distinctEvents(
    app.sentryStub
      .errorEvents("cup-app")
      .filter((event) => event["platform"] === "cocoa" && event.level === "fatal"),
  );
}

async function readInstallationId(webView: WebdriverIO.Browser): Promise<string> {
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

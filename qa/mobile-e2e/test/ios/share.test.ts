import { expect, test } from "vitest";

import { useMobileApp } from "#src/fixtures.ts";
import { asIosAppDevice, type IosAppDevice } from "#src/ios/ios-app-device.ts";
import { signInFromLandingPage, waitForLandingPage, waitForRecents } from "#src/journeys.ts";
import {
  conversionStartsSince,
  expectSignInForStartFormUrl,
  waitForSharedConversions,
} from "#src/share-assertions.ts";

const app = useMobileApp();

const SHARED_URL = "https://source.example.test/fixture";

test("a share fills the landing page's start form and asks to sign in", async () => {
  const device = await launchToLandingPage();

  await device.openUrl(shareLink(SHARED_URL));

  await expectSignInForStartFormUrl(await device.webView(), SHARED_URL);
  expect(conversionStartsSince(app.worker, 0)).toEqual([]);
});

test("a share that starts Cup fills the landing page's start form and asks to sign in", async () => {
  const device = await prepareColdStart();

  await device.openUrl(shareLink(SHARED_URL));

  await expectSignInForStartFormUrl(await device.webView(), SHARED_URL);
  expect(app.worker.requests()).toContainEqual(
    expect.objectContaining({ method: "GET", path: "/api/auth/config" }),
  );
  expect(conversionStartsSince(app.worker, 0)).toEqual([]);
});

test("a signed-in share while Cup is running starts its conversion", async () => {
  const device = await signIn();

  const requestCount = app.worker.requests().length;
  await device.openUrl(shareLink(SHARED_URL));

  expect(
    await waitForSharedConversions(await device.webView(), app.worker, {
      requestCount,
      starts: 1,
      tracks: 2,
    }),
  ).toEqual([SHARED_URL]);
});

test("a signed-in share that starts Cup starts its conversion", async () => {
  const device = await signIn();
  await device.storeApiOrigin(app.apiOrigin);
  await device.terminate();

  const requestCount = app.worker.requests().length;
  await device.openUrl(shareLink(SHARED_URL));

  expect(
    await waitForSharedConversions(await device.webView(), app.worker, {
      requestCount,
      starts: 1,
      tracks: 2,
    }),
  ).toEqual([SHARED_URL]);
});

async function signIn(): Promise<IosAppDevice> {
  const device = asIosAppDevice(app.device);
  await device.launch({ apiOrigin: app.apiOrigin });
  const webView = await device.webView();
  await signInFromLandingPage(device, webView);
  await webView.$('a[aria-label="Back"]').click();
  await waitForRecents(webView, 1);
  return device;
}

async function launchToLandingPage(): Promise<IosAppDevice> {
  const device = asIosAppDevice(app.device);
  await device.launch({ apiOrigin: app.apiOrigin });
  await waitForLandingPage(await device.webView());
  return device;
}

async function prepareColdStart(): Promise<IosAppDevice> {
  const device = asIosAppDevice(app.device);
  expect(await device.appState("cup")).toBe("not running");
  await device.storeApiOrigin(app.apiOrigin);
  return device;
}

function shareLink(url: string): string {
  return `audio.cup.app://share?url=${encodeURIComponent(url)}`;
}

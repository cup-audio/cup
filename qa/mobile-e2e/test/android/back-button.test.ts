import { expect, test } from "vitest";

import { asAndroidAppDevice, type AndroidAppDevice } from "#src/android/android-app-device.ts";
import { useMobileApp } from "#src/fixtures.ts";
import { pathname, signInFromLandingPage, waitForRecents } from "#src/journeys.ts";

const app = useMobileApp();

test("Back from the Add dialog and from a track returns to Recents", async () => {
  const device = asAndroidAppDevice(app.device);
  const webView = await openRecentsAsFirstScreen(device);

  await webView.$('nav[aria-label="Tabs"]').$("a*=Add").click();
  const addDialog = webView.$('[role="dialog"]');
  await addDialog.waitForDisplayed({ timeout: 30_000 });
  expect(
    await webView.execute(() => document.activeElement?.getAttribute("role") === "dialog"),
  ).toBe(true);
  await device.waitForKeyboard("hidden");
  await device.pressBack();
  await addDialog.waitForExist({ reverse: true, timeout: 10_000 });
  await waitForRecents(webView, 1);

  await webView.$('ul[aria-label="Tracks"] > li a').click();
  await webView.waitUntil(async () => (await pathname(webView)).startsWith("/app/audiobooks/"), {
    timeout: 30_000,
    timeoutMsg: "The track's page did not open.",
  });
  await device.pressBack();
  await waitForRecents(webView, 1);
  expect(await device.appState()).toBe("foreground");
});

test("Back on the first screen puts Cup in the background without finishing it", async () => {
  const device = asAndroidAppDevice(app.device);
  let webView = await openRecentsAsFirstScreen(device);
  await webView.execute(() => Reflect.set(window, "cupBackButtonMark", true));

  await device.pressBack();

  await expect.poll(() => device.appState(), { timeout: 10_000, interval: 250 }).toBe("background");
  await device.bringToForeground();
  webView = await device.webView();
  await waitForRecents(webView, 1);
  expect(await webView.execute(() => Reflect.get(window, "cupBackButtonMark"))).toBe(true);
});

async function openRecentsAsFirstScreen(device: AndroidAppDevice): Promise<WebdriverIO.Browser> {
  await device.launch({ apiOrigin: app.apiOrigin });
  await signInFromLandingPage(device, await device.webView());
  await device.relaunch();
  const webView = await device.webView();
  await waitForRecents(webView, 1);
  return webView;
}

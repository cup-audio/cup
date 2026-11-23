import { expect, test } from "vitest";

import { asAndroidAppDevice } from "#src/android/android-app-device.ts";
import { useMobileApp } from "#src/fixtures.ts";
import {
  NARRATION_LINK_URL,
  openNarrationLink,
  openOriginalPage,
  pathname,
  signInFromLandingPage,
} from "#src/journeys.ts";

const app = useMobileApp();

const APP_PACKAGE = "audio.cup.app";

test("a narration document link and Open original page open in the system browser", async () => {
  const device = asAndroidAppDevice(app.device);
  await device.launch({ apiOrigin: app.apiOrigin });
  let webView = await device.webView();
  await signInFromLandingPage(device, webView);
  const audiobookPathname = await pathname(webView);
  const browserPackage = await device.browserPackage(NARRATION_LINK_URL);
  expect(browserPackage).not.toBe(APP_PACKAGE);

  webView = await device.webView();
  await openNarrationLink(webView);
  await expect
    .poll(() => device.focusedPackage(), { timeout: 30_000, interval: 500 })
    .toBe(browserPackage);

  await device.bringToForeground();
  webView = await device.webView();
  expect(await pathname(webView)).toBe(audiobookPathname);
  await openOriginalPage(webView);
  await expect
    .poll(() => device.focusedPackage(), { timeout: 30_000, interval: 500 })
    .toBe(browserPackage);

  await device.bringToForeground();
  webView = await device.webView();
  expect(await pathname(webView)).toBe(audiobookPathname);
});

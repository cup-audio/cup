import { expect, test } from "vitest";

import { useMobileApp } from "#src/fixtures.ts";
import { asIosAppDevice } from "#src/ios/ios-app-device.ts";
import {
  openNarrationLink,
  openOriginalPage,
  pathname,
  signInFromLandingPage,
} from "#src/journeys.ts";

/**
 * Links that leave Cup open in Safari, not in Cup's WebView: Capacitor hands every navigation away
 * from Cup's origin to iOS. The test Worker's hosts are unreachable from Safari, so the test checks
 * only which app is in front.
 */
const app = useMobileApp();

test("a narration document link and Open original page open in Safari", async () => {
  const device = asIosAppDevice(app.device);
  await device.launch({ apiOrigin: app.apiOrigin });
  let webView = await device.webView();
  await signInFromLandingPage(device, webView);
  const audiobookPathname = await pathname(webView);

  await openNarrationLink(webView);
  await expect
    .poll(() => device.appState("safari"), { timeout: 30_000, interval: 500 })
    .toBe("foreground");

  await device.bringToForeground();
  webView = await device.webView();
  expect(await pathname(webView)).toBe(audiobookPathname);
  await openOriginalPage(webView);
  await expect
    .poll(() => device.appState("safari"), { timeout: 30_000, interval: 500 })
    .toBe("foreground");

  await device.bringToForeground();
  webView = await device.webView();
  expect(await pathname(webView)).toBe(audiobookPathname);
});

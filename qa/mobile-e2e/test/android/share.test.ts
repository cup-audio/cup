import { expect, test } from "vitest";

import { asAndroidAppDevice } from "#src/android/android-app-device.ts";
import { useMobileApp } from "#src/fixtures.ts";
import { signInFromLandingPage, waitForRecents } from "#src/journeys.ts";
import {
  conversionStartsSince,
  expectSignInForStartFormUrl,
  waitForSharedConversions,
} from "#src/share-assertions.ts";

const app = useMobileApp();

const SHARED_URL = "https://source.example.test/fixture";

test("a share while Cup is not running starts its conversion", async () => {
  const device = asAndroidAppDevice(app.device);
  await signIn();
  await device.leaveAndTerminate();
  const url = "https://source.example.test/fixture?topic=a+b&page=2#part-2";

  const requestCount = app.worker.requests().length;
  await device.share(url, { apiOrigin: app.apiOrigin });

  expect(
    await waitForSharedConversions(await device.webView(), app.worker, {
      requestCount,
      starts: 1,
      tracks: 2,
    }),
  ).toEqual([url]);
});

test("a share while Cup is running starts a conversion of the URL in the shared text", async () => {
  const device = asAndroidAppDevice(app.device);
  await signIn();

  const requestCount = app.worker.requests().length;
  await device.share(`The fixture's title — ${SHARED_URL}`, { apiOrigin: app.apiOrigin });

  expect(
    await waitForSharedConversions(await device.webView(), app.worker, {
      requestCount,
      starts: 1,
      tracks: 2,
    }),
  ).toEqual([SHARED_URL]);
});

test("a share while signed out fills the landing page's start form and asks to sign in", async () => {
  const device = asAndroidAppDevice(app.device);

  await device.share(SHARED_URL, { apiOrigin: app.apiOrigin });

  await expectSignInForStartFormUrl(await device.webView(), SHARED_URL);
  expect(app.worker.requests()).toContainEqual(
    expect.objectContaining({ method: "GET", path: "/api/auth/config" }),
  );
  expect(conversionStartsSince(app.worker, 0)).toEqual([]);
});

async function signIn(): Promise<WebdriverIO.Browser> {
  await app.device.launch({ apiOrigin: app.apiOrigin });
  const webView = await app.device.webView();
  await signInFromLandingPage(app.device, webView);
  await webView.$('a[aria-label="Back"]').click();
  await waitForRecents(webView, 1);
  return webView;
}

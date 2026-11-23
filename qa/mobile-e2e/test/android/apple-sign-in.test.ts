import { expect, test } from "vitest";

import { asAndroidAppDevice, type AndroidAppDevice } from "#src/android/android-app-device.ts";
import { useMobileApp } from "#src/fixtures.ts";
import { pathname, SOURCE_URL, startSignInFromLandingPage } from "#src/journeys.ts";
import { conversionStartsSince } from "#src/share-assertions.ts";

const app = useMobileApp();

const APP_PACKAGE = "audio.cup.app";
const AUTH_CALLBACK_URL = "audio.cup.app://auth/callback";
const CANCELLATION_GRACE_PERIOD_MS = 3_000;

test("an Apple sign-in that redirects at once signs in and starts the submitted request", async () => {
  const device = asAndroidAppDevice(app.device);
  await device.launch({ apiOrigin: app.apiOrigin });
  const webView = await device.webView();
  await startSignInFromLandingPage(webView);

  await webView.$("button=Continue with Apple").click();

  await waitForStartedConversion(device);
  expect(app.authProvider.authorizationRequests()).toEqual([
    expect.objectContaining({ provider: "apple", redirect_to: AUTH_CALLBACK_URL, scopes: "email" }),
  ]);
  expect(conversionStartsSince(app.worker, 0)).toEqual([SOURCE_URL]);
});

test("backing out of Apple's page ends the sign-in as a cancellation with the dialog still open", async () => {
  const device = asAndroidAppDevice(app.device);
  app.authProvider.holdAuthorizations();
  await device.launch({ apiOrigin: app.apiOrigin });
  let webView = await device.webView();
  await startSignInFromLandingPage(webView);
  const browserPackage = await device.browserPackage("https://appleid.apple.com/");

  await webView.$("button=Continue with Apple").click();
  await expect
    .poll(() => device.focusedPackage(), { timeout: 30_000, interval: 500 })
    .toBe(browserPackage);
  await device.waitForNativeText("Continue");
  await device.pressBackUntilFocused(APP_PACKAGE);
  await new Promise((resolve) => setTimeout(resolve, CANCELLATION_GRACE_PERIOD_MS + 1_000));

  webView = await device.webView();
  expect(await pathname(webView)).toBe("/app/");
  const signIn = webView.$("button=Continue with Apple");
  await expect.poll(() => signIn.isEnabled(), { timeout: 10_000, interval: 250 }).toBe(true);
  expect(await webView.$$("[role=alert]").length).toBe(0);
  expect(app.authProvider.exchanges()).toBe(0);
});

test("an Apple sign-in finishes and starts the submitted request when Android killed Cup while Apple's page was open", async () => {
  const device = asAndroidAppDevice(app.device);
  app.authProvider.holdAuthorizations();
  await device.launch({ apiOrigin: app.apiOrigin });
  const webView = await device.webView();
  await startSignInFromLandingPage(webView);
  const browserPackage = await device.browserPackage("https://appleid.apple.com/");
  await webView.$("button=Continue with Apple").click();
  await expect
    .poll(() => device.focusedPackage(), { timeout: 30_000, interval: 500 })
    .toBe(browserPackage);

  await device.killInBackground();
  await device.tapNativeText("Continue");

  await waitForStartedConversion(device);
  expect(app.authProvider.exchanges()).toBe(1);
  expect(conversionStartsSince(app.worker, 0)).toEqual([SOURCE_URL]);
});

async function waitForStartedConversion(device: AndroidAppDevice): Promise<void> {
  await expect
    .poll(() => device.focusedPackage(), { timeout: 30_000, interval: 500 })
    .toBe(APP_PACKAGE);
  const webView = await device.webView();
  await webView.waitUntil(async () => (await pathname(webView)).startsWith("/app/audiobooks/"), {
    timeout: 60_000,
    timeoutMsg: "Signing in with Apple did not open the new audiobook.",
  });
}

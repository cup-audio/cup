import { expect, test } from "vitest";

import { asAndroidAppDevice } from "#src/android/android-app-device.ts";
import { useMobileApp } from "#src/fixtures.ts";
import { pathname, startSignInFromLandingPage } from "#src/journeys.ts";

const app = useMobileApp();

const GOOGLE_PLAY_SERVICES = "com.google.android.gms";
const ADD_ACCOUNT_ACTIVITY = `${GOOGLE_PLAY_SERVICES}/${GOOGLE_PLAY_SERVICES}.auth.uiflows.minutemaid.MinuteMaidActivity`;

test("cancelling Google's add-account screen returns to a usable landing page", async () => {
  const device = asAndroidAppDevice(app.device);
  await device.launch({ apiOrigin: app.apiOrigin, realGoogleSignIn: true });
  let webView = await device.webView();
  await startSignInFromLandingPage(webView);

  await webView.$("button=Continue with Google").click();
  await expect
    .poll(() => device.focusedPackage(), { timeout: 30_000, interval: 500 })
    .toBe(GOOGLE_PLAY_SERVICES);
  await expect
    .poll(() => device.focusedActivity(), { timeout: 30_000, interval: 500 })
    .toBe(ADD_ACCOUNT_ACTIVITY);
  await expect
    .poll(() => device.showsButton(GOOGLE_PLAY_SERVICES), { timeout: 30_000, interval: 500 })
    .toBe(true);
  await device.pressBack();
  await expect
    .poll(() => device.focusedPackage(), { timeout: 30_000, interval: 500 })
    .toBe("audio.cup.app");

  webView = await device.webView();
  expect(await pathname(webView)).toBe("/app/");
  const signIn = webView.$("button=Continue with Google");
  const keptSignInDialog = await signIn.isDisplayed();
  if (!keptSignInDialog) {
    await startSignInFromLandingPage(webView);
  }
  await expect.poll(() => signIn.isEnabled(), { timeout: 10_000, interval: 250 }).toBe(true);
  const errorsAfterCancel = keptSignInDialog ? (await webView.$$("[role=alert]")).length : 0;
  expect(errorsAfterCancel).toBe(0);
});

import { expect, test } from "vitest";

import { asAndroidAppDevice, type AndroidAppDevice } from "#src/android/android-app-device.ts";
import { useMobileApp } from "#src/fixtures.ts";
import {
  pathname,
  SOURCE_URL,
  startSignInFromLandingPage,
  waitForLandingPage,
  waitForRecents,
} from "#src/journeys.ts";
import { conversionStartsSince } from "#src/share-assertions.ts";

const app = useMobileApp();

const APP_PACKAGE = "audio.cup.app";
const AUTH_CALLBACK_URL = "audio.cup.app://auth/callback";

test("an Apple sign-in that redirects at once signs in and starts the submitted request", async () => {
  const device = asAndroidAppDevice(app.device);
  await device.launch({ apiOrigin: app.apiOrigin });
  const webView = await device.webView();
  await startSignInFromLandingPage(webView);

  await webView.$("button=Continue with Apple").click();

  await waitForStartedConversion(device);
  expect(app.authProvider.authorizationRequests()).toEqual([
    expect.objectContaining({
      provider: "apple",
      redirect_to: AUTH_CALLBACK_URL,
      scopes: "email name",
    }),
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

test("a sign-in callback that starts Cup without launch arguments after a test launch still reaches the test Worker", async () => {
  const device = asAndroidAppDevice(app.device);
  await device.launch({ apiOrigin: app.apiOrigin });
  await waitForLandingPage(await device.webView());
  await device.terminate();
  const requestCount = app.worker.requests().length;

  await device.startFromUrl(`${AUTH_CALLBACK_URL}?code=a-code-no-sign-in-issued`);

  await expect
    .poll(
      () =>
        app.worker
          .requests()
          .slice(requestCount)
          .some((request) => request.method === "GET" && request.path === "/api/auth/config"),
      { timeout: 30_000, interval: 500 },
    )
    .toBe(true);
  await expect
    .poll(() => device.focusedPackage(), { timeout: 30_000, interval: 500 })
    .toBe(APP_PACKAGE);
  expect(app.authProvider.exchanges()).toBe(0);
});

test("confirms an Apple-linked deletion with Apple's refresh token from a fresh sign-in, which the Worker validates and revokes before scheduling", async () => {
  const device = asAndroidAppDevice(app.device);
  await device.launch({ apiOrigin: app.apiOrigin });
  let webView = await device.webView();
  await startSignInFromLandingPage(webView);
  await webView.$("button=Continue with Apple").click();
  await waitForStartedConversion(device);
  webView = await device.webView();
  await webView.$('a[aria-label="Back"]').click();
  await waitForRecents(webView, 1);
  await webView.$('a[aria-label="Account"]').click();
  await webView.$("button=Delete account…").click();
  const confirmation = webView.$('section[aria-label="Confirm account change"]');
  const continueWithApple = confirmation.$("button=Continue with Apple");
  await continueWithApple.waitForEnabled({ timeout: 30_000 });

  await continueWithApple.click();
  await expect
    .poll(() => device.focusedPackage(), { timeout: 30_000, interval: 500 })
    .toBe(APP_PACKAGE);
  webView = await device.webView();
  const scheduleDeletion = webView.$("button=Schedule deletion");
  await scheduleDeletion.waitForEnabled({ timeout: 30_000 });
  await scheduleDeletion.click();
  await waitForLandingPage(webView);

  expect(app.authProvider.exchanges()).toBe(2);
  const deletions = app.worker
    .requests()
    .filter((request) => request.method === "POST" && request.path === "/api/account/deletion");
  expect(deletions).toHaveLength(1);
  const refreshToken = appleRefreshTokenOf(deletions[0]?.body);
  const appleRequests = app.authProvider.appleRequests();
  expect(
    appleRequests.map(({ path, clientId, grantType, token }) => ({
      path,
      clientId,
      grantType,
      token,
    })),
  ).toStrictEqual([
    {
      path: "/auth/token",
      clientId: "audio.cup.app.web",
      grantType: "refresh_token",
      token: refreshToken,
    },
    {
      path: "/auth/revoke",
      clientId: "audio.cup.app.web",
      grantType: undefined,
      token: refreshToken,
    },
  ]);
  const account = await readAccount(deletions[0]?.headers["authorization"]);
  expect(account["state"]).toBe("deletion_scheduled");
  expect(appleRequests[1]?.atMs).toBeLessThanOrEqual(
    Number(account["recoveryDeadlineMs"]) - 7 * 86_400_000,
  );
});

function appleRefreshTokenOf(body: string | undefined): string {
  const confirmation: unknown = JSON.parse(body ?? "{}");
  const credential = isRecord(confirmation) ? confirmation["providerCredential"] : undefined;
  if (
    !isRecord(credential) ||
    credential["provider"] !== "apple" ||
    typeof credential["refreshToken"] !== "string" ||
    "authorizationCode" in credential
  ) {
    throw new Error(`The deletion carried no Apple refresh token: ${String(body)}`);
  }
  return credential["refreshToken"];
}

async function readAccount(authorization: string | undefined): Promise<Record<string, unknown>> {
  const response = await fetch(`${app.worker.origin}/api/account`, {
    headers: { Authorization: authorization ?? "" },
  });
  expect(response.status).toBe(200);
  const account: unknown = await response.json();
  if (!isRecord(account)) {
    throw new Error("The Worker answered no account.");
  }
  return account;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

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

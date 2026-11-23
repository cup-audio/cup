import { expect, test } from "vitest";

import { useMobileApp } from "#src/fixtures.ts";
import { asIosAppDevice } from "#src/ios/ios-app-device.ts";
import {
  pathname,
  startSignInFromLandingPage,
  waitForLandingPage,
  waitForRecents,
} from "#src/journeys.ts";

const app = useMobileApp();

test("signs in with Apple through the native sheet's fake and opens the new audiobook with an Apple session", async () => {
  const device = asIosAppDevice(app.device);
  await device.launch({ apiOrigin: app.apiOrigin });
  const webView = await device.webView();
  await startSignInFromLandingPage(webView);

  await webView.$("button=Continue with Apple").click();

  await webView.waitUntil(async () => (await pathname(webView)).startsWith("/app/audiobooks/"), {
    timeout: 60_000,
    timeoutMsg: "Signing in with Apple did not open the new audiobook.",
  });
  const startRequest = app.worker
    .requests()
    .find((request) => request.method === "POST" && request.path === "/api/account/conversions");
  expect(claimsOf(startRequest?.headers["authorization"])).toMatchObject({
    app_metadata: { providers: ["apple"] },
    amr: [{ method: "id_token" }],
  });
});

test("closing Apple's sheet leaves the sign-in dialog open without an error", async () => {
  const device = asIosAppDevice(app.device);
  await device.launch({ apiOrigin: app.apiOrigin, shouldCancelAppleSignIn: true });
  const webView = await device.webView();
  await startSignInFromLandingPage(webView);
  const exchangesBefore = app.authProvider.exchanges();

  const signIn = webView.$("button=Continue with Apple");
  await signIn.click();

  await expect.poll(() => signIn.isEnabled(), { timeout: 10_000, interval: 250 }).toBe(true);
  expect(await signIn.getText()).toBe("Continue with Apple");
  expect(await webView.$$("[role=alert]").length).toBe(0);
  expect(await pathname(webView)).toBe("/app/");
  expect(app.authProvider.exchanges()).toBe(exchangesBefore);
});

test("confirms an Apple-linked deletion with the native sheet's authorization code, which the Worker exchanges and revokes before scheduling", async () => {
  const device = asIosAppDevice(app.device);
  await device.launch({ apiOrigin: app.apiOrigin });
  const webView = await device.webView();
  await startSignInFromLandingPage(webView);
  await webView.$("button=Continue with Apple").click();
  await webView.waitUntil(async () => (await pathname(webView)).startsWith("/app/audiobooks/"), {
    timeout: 60_000,
    timeoutMsg: "Signing in with Apple did not open the new audiobook.",
  });
  await webView.$('a[aria-label="Back"]').click();
  await waitForRecents(webView, 1);
  await webView.$('a[aria-label="Account"]').click();
  const confirmDeletionWithApple = async () => {
    await webView.$("button=Delete account…").click();
    const confirmation = webView.$('section[aria-label="Confirm account change"]');
    const continueWithApple = confirmation.$("button=Continue with Apple");
    await continueWithApple.waitForEnabled({ timeout: 30_000 });
    expect(await confirmation.$$("button").map((button) => button.getText())).toStrictEqual([
      "Continue with Apple",
      "Cancel",
    ]);
    await continueWithApple.click();
    const scheduleDeletion = webView.$("button=Schedule deletion");
    await scheduleDeletion.waitForEnabled({ timeout: 30_000 });
    return scheduleDeletion;
  };

  const scheduleWithExpiredCode = await confirmDeletionWithApple();
  app.authProvider.expireAppleAuthorizationCodes();
  await scheduleWithExpiredCode.click();
  await webView.waitUntil(
    async () =>
      (await webView.$('[role="alert"]').getText()) ===
      "Apple couldn't confirm the deletion. Your account is still active, and nothing will be deleted. Try again.",
    { timeout: 30_000, timeoutMsg: "The expired Apple code did not show Apple's failure." },
  );
  await (await confirmDeletionWithApple()).click();
  await waitForLandingPage(webView);

  const deletions = app.worker
    .requests()
    .filter((request) => request.method === "POST" && request.path === "/api/account/deletion");
  const codes = deletions.map((request) => nativeAppleCodeOf(request.body));
  expect(codes).toHaveLength(2);
  expect(codes[0]).not.toBe(codes[1]);
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
      clientId: "audio.cup.app",
      grantType: "authorization_code",
      token: codes[0],
    },
    {
      path: "/auth/token",
      clientId: "audio.cup.app",
      grantType: "authorization_code",
      token: codes[1],
    },
    {
      path: "/auth/revoke",
      clientId: "audio.cup.app",
      grantType: undefined,
      token: expect.any(String),
    },
  ]);
  const account = await readAccount(deletions.at(-1)?.headers["authorization"]);
  expect(account["state"]).toBe("deletion_scheduled");
  expect(appleRequests[2]?.atMs).toBeLessThanOrEqual(
    Number(account["recoveryDeadlineMs"]) - 7 * 86_400_000,
  );
});

function nativeAppleCodeOf(body: string | undefined): string {
  const confirmation: unknown = JSON.parse(body ?? "{}");
  const credential = isRecord(confirmation) ? confirmation["providerCredential"] : undefined;
  if (
    !isRecord(credential) ||
    credential["provider"] !== "apple" ||
    typeof credential["authorizationCode"] !== "string" ||
    "refreshToken" in credential
  ) {
    throw new Error(`The deletion carried no native Apple credential: ${String(body)}`);
  }
  return credential["authorizationCode"];
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

function claimsOf(authorization: string | undefined): Record<string, unknown> {
  const token = /^Bearer (\S+)$/.exec(authorization ?? "")?.[1];
  if (token === undefined) {
    throw new Error(`The request carried no bearer token: ${String(authorization)}`);
  }
  const claims: unknown = JSON.parse(
    Buffer.from(token.split(".")[1] ?? "", "base64url").toString(),
  );
  if (typeof claims !== "object" || claims === null) {
    throw new Error("The bearer token has no claims.");
  }
  return { ...claims };
}

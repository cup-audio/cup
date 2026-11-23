import { expect, test } from "vitest";

import { useMobileApp } from "#src/fixtures.ts";
import { asIosAppDevice } from "#src/ios/ios-app-device.ts";
import { pathname, startSignInFromLandingPage } from "#src/journeys.ts";

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
  await device.launch({ apiOrigin: app.apiOrigin, cancelAppleSignIn: true });
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

import { expect, test } from "vitest";

import type { RecordedRequest } from "@cup/test-worker";

import { useMobileApp } from "#src/fixtures.ts";
import {
  pathname,
  signInFromHomeLink,
  signInFromLandingPage,
  waitForLandingPage,
  waitForRecents,
} from "#src/journeys.ts";

const app = useMobileApp();

test("signs in from the home page's sign-in link and lands on Recents loaded from the test Worker", async () => {
  await app.device.launch({ apiOrigin: app.apiOrigin });
  const webView = await app.device.webView();

  await signInFromHomeLink(app.device, webView);

  await webView.$("a=Add your first track").waitForDisplayed({ timeout: 30_000 });
  expect(app.worker.requests()).toContainEqual(
    expect.objectContaining({
      method: "GET",
      path: "/api/account/conversions",
      headers: expect.objectContaining({ authorization: expect.stringMatching(/^Bearer \S+$/) }),
    }),
  );
});

test("refreshes the session when Cup comes back from the background after its access token expired", async () => {
  app.authProvider.setAccessTokenLifetime(ACCESS_TOKEN_LIFETIME_SECONDS);
  await app.device.launch({ apiOrigin: app.apiOrigin });
  let webView = await app.device.webView();
  await signInFromLandingPage(app.device, webView);
  await webView.$('a[aria-label="Back"]').click();
  await waitForRecents(webView, 1);
  const tokenBeforeBackground = lastConversionsAuthorization();
  expect(tokenBeforeBackground).toMatch(/^Bearer \S+$/);

  await app.device.background();
  await new Promise((resolve) => setTimeout(resolve, (ACCESS_TOKEN_LIFETIME_SECONDS + 1) * 1_000));
  const refreshesInBackground = app.authProvider.refreshes();
  await app.device.bringToForeground();
  webView = await app.device.webView();

  await expect
    .poll(() => app.authProvider.refreshes(), { timeout: 10_000, interval: 250 })
    .toBeGreaterThan(refreshesInBackground);
  const requestsBeforeReturning = app.worker.requests().length;
  await webView.$('ul[aria-label="Tracks"] a').click();
  await webView.waitUntil(async () => (await pathname(webView)).startsWith("/app/audiobooks/"), {
    timeout: 30_000,
    timeoutMsg: "The track did not open.",
  });
  await webView.$('a[aria-label="Back"]').click();
  await waitForRecents(webView, 1);
  await expect
    .poll(() => app.worker.requests().slice(requestsBeforeReturning).some(isConversionsRequest), {
      timeout: 10_000,
      interval: 250,
    })
    .toBe(true);
  const tokenAfterForeground = lastConversionsAuthorization();
  expect(tokenAfterForeground).toMatch(/^Bearer \S+$/);
  expect(tokenAfterForeground).not.toBe(tokenBeforeBackground);
  expect(app.worker.logs.filter((line) => line.includes("401 Unauthorized"))).toEqual([]);
});

const ACCESS_TOKEN_LIFETIME_SECONDS = 2;

function lastConversionsAuthorization(): string | undefined {
  return app.worker.requests().findLast(isConversionsRequest)?.headers["authorization"];
}

function isConversionsRequest(request: RecordedRequest): boolean {
  return request.method === "GET" && request.path === "/api/account/conversions";
}

test("stays signed out after signing out and relaunching", async () => {
  await app.device.launch({ apiOrigin: app.apiOrigin });
  let webView = await app.device.webView();
  await signInFromLandingPage(app.device, webView);
  await webView.$('a[aria-label="Back"]').click();
  await waitForRecents(webView, 1);

  await webView.$('a[aria-label="Account"]').click();
  await webView.$("button=Delete account…").click();
  await app.device.continueGoogleSignIn();
  const scheduleDeletion = webView.$("button=Schedule deletion");
  await scheduleDeletion.waitForEnabled({ timeout: 30_000 });
  await scheduleDeletion.click();
  await waitForLandingPage(webView);

  await app.device.relaunch();
  webView = await app.device.webView();

  await waitForLandingPage(webView);
  expect(await pathname(webView)).toBe("/app/");
});

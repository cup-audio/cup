import type { Page, Response } from "@playwright/test";
import { Temporal } from "temporal-polyfill";

import { accountSnapshotSchema, scheduleDeletionResponseSchema } from "@cup/listener-api.routes";

import { VISUAL_TAG } from "#test-e2e/browser-project-tags.ts";
import { expect, test } from "#test-e2e/fixtures.ts";
import { readAccessToken, waitForAudiobook } from "#test-e2e/journey.ts";
import { readAudiobook, waitForGeneratedAudio } from "#test-e2e/synthesis.ts";

const SOURCE_URL = "https://source.example.test/fixture";

test(
  "Google PKCE signup resumes conversion, protects Recents and media, and supports deletion recovery",
  { tag: VISUAL_TAG },
  async ({ expectConsoleError, page, workerEnvironment }) => {
    test.setTimeout(60_000);
    const { origin, authProvider } = workerEnvironment;
    await page.goto(`${origin}/app/`);
    await page.getByRole("textbox", { name: "URL", exact: true }).fill(SOURCE_URL);
    await page.getByRole("button", { name: "Listen" }).click();
    const signup = page.getByRole("dialog", { name: "Sign in", exact: true });
    await expect(signup).toBeVisible();
    await expect(page).toHaveScreenshot("signup-prompt.png");
    await signup.getByRole("button", { name: "Continue with Google" }).click();
    await expect(page).toHaveURL(/\/app\/audiobooks\//, { timeout: 60_000 });
    expect(authProvider.exchanges()).toBe(1);
    expect(authProvider.authorizationRequests().at(-1)).not.toHaveProperty("prompt");
    const conversionId = new URL(page.url()).pathname.split("/").at(-1);
    await waitForAudiobook(page);
    if (!conversionId) {
      throw new Error("Conversion missing");
    }
    await waitForGeneratedAudio(page, conversionId, await readAccessToken(page));
    const audiobook = await readAudiobook(page, conversionId, await readAccessToken(page));
    if (audiobook.status !== "ready" || !audiobook.narrationTrack) {
      throw new Error("Expected a narration track once every segment has audio.");
    }
    const trackUrl = audiobook.narrationTrack.url;
    const remainingAllowance = (await readAccount(page, origin)).balance.available;
    expect(remainingAllowance).toBeLessThan(30 * 60 * 1_000);
    await page.reload();
    await waitForAudiobook(page);
    await expect
      .poll(() => page.evaluate(async (url) => (await fetch(url)).status, trackUrl))
      .toBe(200);
    const trackPath = new URL(trackUrl).pathname;
    for (const token of [await readAccessToken(page), authProvider.otherToken()]) {
      expect(
        (
          await page.request.get(origin + trackPath, {
            headers: { Authorization: `Bearer ${token}` },
          })
        ).status(),
      ).toBe(401);
    }
    await page.goto(`${origin}/app/recent`);
    await expect(page.getByRole("list", { name: "Tracks" }).getByRole("link")).toHaveCount(1);
    await expect(page.locator("main")).toHaveScreenshot("private-recents.png");
    await page.goto(`${origin}/app/recent/account`);
    await page.getByRole("button", { name: "Delete account…" }).click();
    await expect(page.getByRole("button", { name: "Schedule deletion" })).toBeVisible();
    await expect.poll(() => authProvider.exchanges()).toBe(2);
    expect(authProvider.authorizationRequests().at(-1)).toMatchObject({
      prompt: "select_account",
      max_age: "0",
    });
    await scheduleDeletion(page);
    await expect(page).toHaveURL(`${origin}/app/`);
    await expect.poll(async () => (await page.request.get(trackUrl)).status()).toBe(403);
    expectConsoleError(/^Failed to load resource: the server responded with a status of 403/);
    await page.goto(`${origin}/app/`);
    await page.getByRole("textbox", { name: "URL", exact: true }).fill(SOURCE_URL);
    await page.getByRole("button", { name: "Listen" }).click();
    await page.getByRole("button", { name: "Continue with Google", exact: true }).click();
    await expect.poll(() => authProvider.exchanges()).toBe(3);
    expect(authProvider.authorizationRequests().at(-1)).toMatchObject({ prompt: "select_account" });
    expect(authProvider.authorizationRequests().at(-1)).not.toHaveProperty("max_age");
    await expect(page.getByRole("alert")).toBeVisible();
    await page.evaluate(() => localStorage.removeItem("cup_supabase_session"));
    await page.goto(`${origin}/app/account-recovery`);
    await page.getByRole("button", { name: "Continue with Google", exact: true }).click();
    await expect.poll(() => authProvider.exchanges()).toBe(4);
    expect(authProvider.authorizationRequests().at(-1)).not.toHaveProperty("prompt");
    await expect(page.getByRole("heading", { name: "Deletion scheduled" })).toBeVisible();
    await page.getByRole("button", { name: "Restore account…" }).click();
    await expect.poll(() => authProvider.exchanges()).toBe(5);
    await page.getByRole("button", { name: "Confirm recovery" }).click();
    await expect(
      page.getByText(
        "Your account is restored. Your existing minutes and conversions are available again.",
      ),
    ).toBeVisible();
    await expect(page.getByText("This account is not scheduled for deletion.")).toHaveCount(0);
    expect((await readAccount(page, origin)).balance.available).toBe(remainingAllowance);
    await page.goto(`${origin}/app/recent`);
    await expect(page.getByRole("list", { name: "Tracks" }).getByRole("link")).toHaveCount(1);
    let resumedRequests = 0;
    page.on("request", (request) => {
      if (
        request.method() === "POST" &&
        new URL(request.url()).pathname === "/api/account/conversions"
      ) {
        resumedRequests += 1;
      }
    });
    await page.goto(`${origin}/app/`);
    await expect(page).toHaveURL(/\/app\/audiobooks\//, { timeout: 60_000 });
    expect(resumedRequests).toBe(1);
    await page.goto(`${origin}/app/recent`);
    await expect(page.getByRole("list", { name: "Tracks" }).getByRole("link")).toHaveCount(2);
  },
);

test("a new listener creates an account with Apple, and the submitted request resumes after the sign-in", async ({
  page,
  workerEnvironment,
}) => {
  test.setTimeout(60_000);
  const { origin, authProvider } = workerEnvironment;
  await page.goto(`${origin}/app/`);
  await page.getByRole("textbox", { name: "URL", exact: true }).fill(SOURCE_URL);
  await page.getByRole("button", { name: "Listen" }).click();
  await page
    .getByRole("dialog", { name: "Sign in", exact: true })
    .getByRole("button", { name: "Continue with Apple", exact: true })
    .click();

  await expect(page).toHaveURL(/\/app\/audiobooks\//, { timeout: 60_000 });
  await waitForAudiobook(page);
  expect(authProvider.exchanges()).toBe(1);
  expect(authProvider.authorizationRequests().at(-1)).toMatchObject({
    provider: "apple",
    scopes: "email",
  });
  expect(claimsOf(await readAccessToken(page))).toMatchObject({
    app_metadata: { providers: ["apple"] },
  });
  expect((await readAccount(page, origin)).balance.available).toBeLessThan(30 * 60 * 1_000);
});

test("an Apple sign-in with a Google user's email opens that account, and a Hide My Email sign-in opens its own", async ({
  page,
  workerEnvironment,
}) => {
  const { origin, authProvider } = workerEnvironment;
  const signInAs = async (method: "Apple" | "Google") => {
    await signInFromLink(page, origin, method);
    return {
      accountId: (await readAccount(page, origin)).accountId,
      claims: claimsOf(await readAccessToken(page)),
    };
  };
  await page.goto(`${origin}/app/`);

  const google = await signInAs("Google");
  const apple = await signInAs("Apple");
  authProvider.setAppleEmail("qa-relay@privaterelay.appleid.com");
  const hideMyEmail = await signInAs("Apple");

  expect(apple.accountId).toBe(google.accountId);
  expect(apple.claims).toMatchObject({ app_metadata: { providers: ["google", "apple"] } });
  expect(hideMyEmail.accountId).not.toBe(google.accountId);
  expect(hideMyEmail.claims).toMatchObject({
    email: "qa-relay@privaterelay.appleid.com",
    app_metadata: { providers: ["apple"] },
  });
});

test("signup keeps trial conversions separate from the new account and its Recents", async ({
  page,
  request: isolatedRequest,
  workerEnvironment,
}) => {
  test.setTimeout(90_000);
  const { origin } = workerEnvironment;
  const grant = await workerEnvironment.createGrant();
  const credential = new URL(grant.trialLink).hash;
  await page.goto(`${origin}/app/trials/${grant.grantId}${credential}`);
  await page.getByRole("textbox", { name: "URL" }).fill(SOURCE_URL);
  await page.getByRole("button", { name: "Listen" }).click();
  await expect(page).toHaveURL(/\/app\/audiobooks\//, { timeout: 60_000 });
  const originalUrl = page.url();
  const originalId = new URL(originalUrl).pathname.split("/").at(-1);
  await waitForAudiobook(page);
  if (!originalId) {
    throw new Error("Conversion missing");
  }
  await waitForGeneratedAudio(page, originalId);
  let importRequests = 0;
  page.on("request", (request) => {
    if (new URL(request.url()).pathname.startsWith("/api/account/imports")) {
      importRequests += 1;
    }
  });
  await page.goto(`${origin}/app/`);
  await page.getByRole("textbox", { name: "URL", exact: true }).fill(SOURCE_URL);
  await page.getByRole("button", { name: "Listen" }).click();
  await page.getByRole("button", { name: "Continue with Google", exact: true }).click();
  await expect(page).toHaveURL(/\/app\/audiobooks\//, { timeout: 60_000 });
  await waitForAudiobook(page);
  const accountConversionId = new URL(page.url()).pathname.split("/").at(-1);
  if (!accountConversionId) {
    throw new Error("Conversion missing");
  }
  const segments = await waitForGeneratedAudio(
    page,
    accountConversionId,
    await readAccessToken(page),
  );
  const expectedAllowance =
    30 * 60 * 1_000 -
    segments.reduce((total, segment) => total + Math.ceil(segment.durationMilliseconds), 0);
  expect((await readAccount(page, origin)).balance.available).toBe(expectedAllowance);
  const privateAudiobook = await readAudiobook(
    page,
    accountConversionId,
    await readAccessToken(page),
  );
  if (privateAudiobook.status !== "ready" || !privateAudiobook.narrationTrack) {
    throw new Error("Expected a narration track once every segment has audio.");
  }
  const privateTrackUrl = privateAudiobook.narrationTrack.url;
  const privateUrl = page.url();
  const privateId = new URL(privateUrl).pathname.split("/").at(-1);
  expect(privateId).not.toBe(originalId);
  const accessToken = await readAccessToken(page);
  expect(
    (
      await isolatedRequest.get(`${origin}/api/audiobooks/${originalId}`, {
        headers: { Authorization: `Bearer ${accessToken}` },
      })
    ).status(),
  ).toBe(401);
  await page.goto(origin + "/app/recent");
  const ownConversions = page.getByRole("list", { name: "Tracks" }).getByRole("link");
  await expect(ownConversions).toHaveCount(1);
  await expect(ownConversions).toHaveAttribute("href", new URL(privateUrl).pathname);
  expect(importRequests).toBe(0);
  await page.goto(`${origin}/app/recent/account`);
  await page.getByRole("button", { name: "Delete account…", exact: true }).click();
  await scheduleDeletion(page);
  await expect.poll(async () => (await page.request.get(privateTrackUrl)).status()).toBe(403);
  expect((await page.request.get(origin + new URL(privateTrackUrl).pathname)).status()).toBe(401);
  expect(
    (
      await isolatedRequest.get(`${origin}/api/files/audiobooks/${originalId}/narration-track.mp3`)
    ).status(),
  ).toBe(401);

  await page.goto(`${origin}/app/account-recovery`);
  await page.getByRole("button", { name: "Continue with Google", exact: true }).click();
  await expect(page.getByRole("heading", { name: "Deletion scheduled" })).toBeVisible();
  await expect(page).toHaveURL(`${origin}/app/account-recovery`);
});

test("signed-in accounts skip trial credentials and signed-out users can reopen trial links", async ({
  page,
  workerEnvironment,
}) => {
  const { origin } = workerEnvironment;
  const grant = await workerEnvironment.createGrant();
  const trialUrl = `${origin}/app/trials/${grant.grantId}${new URL(grant.trialLink).hash}`;
  await page.goto(`${origin}/app/`);
  await page.getByRole("textbox", { name: "URL", exact: true }).fill(SOURCE_URL);
  await page.getByRole("button", { name: "Listen" }).click();
  await page.getByRole("button", { name: "Continue with Google", exact: true }).click();
  await expect(page).toHaveURL(/\/app\/audiobooks\//, { timeout: 60_000 });

  let trialRequests = 0;
  page.on("request", (request) => {
    if (new URL(request.url()).pathname.startsWith(`/api/grants/${grant.grantId}`)) {
      trialRequests += 1;
    }
  });
  await page.goto(trialUrl);
  await expect(page).toHaveURL(`${origin}/app/recent`);
  expect(trialRequests).toBe(0);
  await page.goto(`${origin}/app/recent/account`);
  await page.getByRole("button", { name: "Delete account…", exact: true }).click();
  await scheduleDeletion(page);
  await expect(page).toHaveURL(`${origin}/app/`);
  await page.goto(trialUrl);
  await expect(page).toHaveURL(`${origin}/app/trials/${grant.grantId}`);
  await expect(page.getByRole("textbox", { name: "URL", exact: true })).toBeVisible();
  expect(trialRequests).toBeGreaterThan(0);
});

test("trial OAuth callback redirect does not depend on working authentication", async ({
  expectConsoleError,
  page,
  workerEnvironment,
}) => {
  const { origin } = workerEnvironment;
  const grant = await workerEnvironment.createGrant();
  await page.route("**/api/auth/config", (route) => route.fulfill({ status: 503 }));
  let trialRequests = 0;
  page.on("request", (request) => {
    if (new URL(request.url()).pathname.startsWith(`/api/grants/${grant.grantId}`)) {
      trialRequests += 1;
    }
  });
  const query = "?code=test-code&from=google";
  for (let attempt = 0; attempt < 2; attempt += 1) {
    expectConsoleError(/^Failed to load resource: the server responded with a status of 503/);
    await page.goto(
      `${origin}/app/trials/${grant.grantId}${query}${new URL(grant.trialLink).hash}`,
    );
    await expect(page).toHaveURL(`${origin}/app/${query}`);
    await expect(page.getByRole("textbox", { name: "URL", exact: true })).toBeVisible();
  }
  expect(trialRequests).toBe(0);
});

test("root auth handles signup and session restoration without account navigation", async ({
  page,
  workerEnvironment,
}) => {
  const { origin, authProvider } = workerEnvironment;
  await page.goto(`${origin}/app/`);
  await expect(page.getByRole("navigation", { name: "Account" })).toHaveCount(0);
  await page.getByRole("textbox", { name: "URL", exact: true }).fill(SOURCE_URL);
  await page.getByRole("button", { name: "Listen" }).click();
  await page.getByRole("button", { name: "Continue with Google", exact: true }).click();
  await expect(page).toHaveURL(/\/app\/audiobooks\/[^?]+$/, { timeout: 60_000 });
  expect(authProvider.exchanges()).toBe(1);
  const privateUrl = page.url();
  await page.reload();
  await expect(page).toHaveURL(privateUrl);
  await expect(page.getByRole("button", { name: "Play", exact: true })).toBeEnabled({
    timeout: 60_000,
  });

  await page.goto(`${origin}/app/recent/add`);
  const addDialog = page.getByRole("dialog", { name: "Add a track" });
  await addDialog.getByRole("textbox", { name: "URL", exact: true }).fill(SOURCE_URL);
  await addDialog.getByRole("button", { name: "Add", exact: true }).click();
  await expect(addDialog).toHaveCount(0, { timeout: 60_000 });
  expect(authProvider.exchanges()).toBe(1);
  const tracks = page.getByRole("list", { name: "Tracks" });
  await expect(tracks.getByRole("listitem")).toHaveCount(2);
  const titledTracks = tracks.getByRole("link", {
    name: "A deterministic document about careful testing",
  });
  await expect(titledTracks).toHaveCount(2, { timeout: 90_000 });
  await expect(tracks.getByText("source.example.test", { exact: true })).toHaveCount(2);
  await expect(
    tracks.getByText("Real boundaries and fake providers make every run the same."),
  ).toHaveCount(0);
  await titledTracks.first().click();
  await expect(page).not.toHaveURL(privateUrl);
  await expect(page.getByRole("button", { name: "Play", exact: true })).toBeEnabled({
    timeout: 60_000,
  });
});

test("a signed-in session refreshes its expired access token and keeps working, also after a reload", async ({
  page,
  workerEnvironment,
}) => {
  test.setTimeout(150_000);
  const { origin, authProvider } = workerEnvironment;
  authProvider.setAccessTokenLifetime(ACCESS_TOKEN_LIFETIME_SECONDS);
  await page.goto(`${origin}/app/`);
  await page.getByRole("textbox", { name: "URL", exact: true }).fill(SOURCE_URL);
  await page.getByRole("button", { name: "Listen" }).click();
  await page.getByRole("button", { name: "Continue with Google", exact: true }).click();
  await expect(page).toHaveURL(/\/app\/audiobooks\//, { timeout: 60_000 });
  const detailUrl = page.url();
  const signInToken = await readAccessToken(page);

  await waitPastExpiry(signInToken);
  const expired = await page.request.get(`${origin}/api/account`, {
    headers: { Authorization: `Bearer ${signInToken}` },
  });
  expect(expired.status()).toBe(401);

  await page.goto(`${origin}/app/recent`);
  await expect(page.getByRole("list", { name: "Tracks" }).getByRole("listitem")).toHaveCount(1);
  const tokenBeforeOpening = await readAccessToken(page);
  await waitPastExpiry(tokenBeforeOpening);
  const afterOpening = waitForAuthenticatedApiResponse(page, origin);
  await page.getByRole("list", { name: "Tracks" }).getByRole("link").click();
  await expect(page).toHaveURL(detailUrl);
  await waitForAudiobook(page);
  await expectRefreshedBearerToken(await afterOpening, [signInToken, tokenBeforeOpening]);

  const tokenBeforeReload = await readAccessToken(page);
  await waitPastExpiry(tokenBeforeReload);
  const afterReload = waitForAuthenticatedApiResponse(page, origin);
  await page.reload();
  await waitForAudiobook(page);
  await expectRefreshedBearerToken(await afterReload, [signInToken, tokenBeforeReload]);
  expect(authProvider.refreshes()).toBeGreaterThanOrEqual(2);
  expect(authProvider.exchanges()).toBe(1);
});

const ACCESS_TOKEN_LIFETIME_SECONDS = 2;
const EXPIRY_MARGIN_MILLISECONDS = 250;

async function waitPastExpiry(accessToken: string) {
  const expiresAtMilliseconds = readExpiry(accessToken) * 1_000;
  const waitMilliseconds =
    Math.max(0, expiresAtMilliseconds - Temporal.Now.instant().epochMilliseconds) +
    EXPIRY_MARGIN_MILLISECONDS;
  await new Promise((resolve) => setTimeout(resolve, waitMilliseconds));
}

function readExpiry(accessToken: string): number {
  const payload = accessToken.split(".")[1];
  if (payload === undefined) {
    throw new Error("Expected a JWT access token");
  }

  const claims: unknown = JSON.parse(Buffer.from(payload, "base64url").toString());
  if (
    !claims ||
    typeof claims !== "object" ||
    !("exp" in claims) ||
    typeof claims.exp !== "number"
  ) {
    throw new Error("Expected an access token with a numeric exp claim");
  }
  return claims.exp;
}

function waitForAuthenticatedApiResponse(page: Page, origin: string) {
  return page.waitForResponse(
    (response) =>
      response.url().startsWith(`${origin}/api/`) &&
      response.request().headers()["authorization"]?.startsWith("Bearer ") === true,
  );
}

async function expectRefreshedBearerToken(response: Response, expiredTokens: string[]) {
  expect(response.ok()).toBe(true);
  const authorization = response.request().headers()["authorization"];
  for (const expiredToken of expiredTokens) {
    expect(authorization).not.toBe(`Bearer ${expiredToken}`);
  }
}

test("failed sign-in leaves anonymous trial access available", async ({
  expectConsoleError,
  page,
  workerEnvironment,
}) => {
  const { origin } = workerEnvironment;
  const grant = await workerEnvironment.createGrant();
  await page.route("**/api/auth/config", (route) => {
    expectConsoleError(/^Failed to load resource: the server responded with a status of 503/);
    return route.fulfill({
      status: 503,
      json: { error: { message: "Sign-in is temporarily unavailable." } },
    });
  });
  await page.goto(`${origin}/app/`);
  await page.getByRole("textbox", { name: "URL", exact: true }).fill(SOURCE_URL);
  await page.getByRole("button", { name: "Listen" }).click();
  await page.getByRole("button", { name: "Continue with Google", exact: true }).click();
  await expect(
    page.getByText("Sign-in is temporarily unavailable.", { exact: true }),
  ).toBeVisible();
  await page.getByRole("button", { name: "Cancel", exact: true }).click();
  await page.goto(`${origin}/app/trials/${grant.grantId}${new URL(grant.trialLink).hash}`);
  await expect(page).toHaveURL(`${origin}/app/trials/${grant.grantId}`);
  await page.getByRole("textbox", { name: "URL", exact: true }).fill(SOURCE_URL);
  await page.getByRole("button", { name: "Listen" }).click();
  await expect(page).toHaveURL(/\/app\/audiobooks\//, { timeout: 60_000 });
  await expect(page.getByRole("button", { name: "Play", exact: true })).toBeEnabled({
    timeout: 60_000,
  });
});

test("a listener deletes a track from its detail view, and the duration it used stays spent", async ({
  expectConsoleError,
  page,
  workerEnvironment,
}) => {
  const { origin } = workerEnvironment;
  await page.goto(`${origin}/app/`);
  await page.getByRole("textbox", { name: "URL", exact: true }).fill(SOURCE_URL);
  await page.getByRole("button", { name: "Listen" }).click();
  await page.getByRole("button", { name: "Continue with Google", exact: true }).click();
  await expect(page).toHaveURL(/\/app\/audiobooks\//, { timeout: 60_000 });
  const detailUrl = page.url();
  const conversionId = new URL(detailUrl).pathname.split("/").at(-1);
  if (!conversionId) {
    throw new Error("Conversion missing");
  }
  await waitForGeneratedAudio(page, conversionId, await readAccessToken(page));
  const remainingAllowance = (await readAccount(page, origin)).balance.available;
  expect(remainingAllowance).toBeLessThan(30 * 60 * 1_000);

  await page.goto(`${origin}/app/recent`);
  await page.getByRole("list", { name: "Tracks" }).getByRole("link").click();
  await expect(page).toHaveURL(detailUrl);
  await waitForAudiobook(page);
  await page.getByRole("button", { name: "More", exact: true }).click();
  await page.getByRole("menuitem", { name: "Delete track" }).click();
  await page
    .getByRole("alertdialog", { name: "Delete track?" })
    .getByRole("button", { name: "Delete", exact: true })
    .click();

  await expect(page).toHaveURL(`${origin}/app/recent`);
  await expect(page.getByRole("link", { name: "Add your first track" })).toBeVisible();
  await expect(page.getByRole("list", { name: "Tracks" })).toHaveCount(0);
  expectConsoleError(/^Failed to load resource: the server responded with a status of 404/);
  expectConsoleError(/^RpcError: Track not found\./);
  expectConsoleError(/^RpcError: Track not found\./);
  await page.goForward();
  await expect(page).toHaveURL(detailUrl);
  await expect(page.getByText("Track not found.")).toBeVisible();
  expect((await readAccount(page, origin)).balance.available).toBe(remainingAllowance);
});

test("an Apple-linked account confirms deletion with Apple, whose sign-in is revoked before the deletion is scheduled", async ({
  page,
  workerEnvironment,
}) => {
  const { origin, authProvider } = workerEnvironment;
  await signInFromLink(page, origin, "Apple");
  await page.goto(`${origin}/app/recent/account`);
  await page.getByRole("button", { name: "Delete account…", exact: true }).click();
  const confirmation = page.getByRole("region", { name: "Confirm account change" });
  await expect(confirmation.getByRole("button")).toHaveText(["Continue with Apple", "Cancel"]);
  await expect(confirmation.getByText("Can't sign in with Apple?")).toBeVisible();

  await confirmation.getByRole("button", { name: "Continue with Apple", exact: true }).click();
  await expect.poll(() => authProvider.exchanges()).toBe(2);
  expect(authProvider.authorizationRequests().at(-1)).toMatchObject({ provider: "apple" });
  const scheduled = page.waitForResponse(
    (response) =>
      response.request().method() === "POST" &&
      new URL(response.url()).pathname === "/api/account/deletion",
  );
  await scheduleDeletion(page);
  const response = await scheduled;
  await expect(page).toHaveURL(`${origin}/app/`);

  expect(response.status()).toBe(200);
  const { recoveryDeadlineMs = 0 } = scheduleDeletionResponseSchema.parse(await response.json());
  expect(recoveryDeadlineMs).toBeGreaterThan(0);
  const appleRequests = authProvider.appleRequests();
  expect(appleRequests.map(({ path, clientId }) => ({ path, clientId }))).toStrictEqual([
    { path: "/auth/token", clientId: "audio.cup.app.web" },
    { path: "/auth/revoke", clientId: "audio.cup.app.web" },
  ]);
  expect(appleRequests[1]?.token).toBe(appleRequests[0]?.token);
  expect(appleRequests[1]?.atMs).toBeLessThanOrEqual(recoveryDeadlineMs - 7 * 86_400_000);
});

test("an Apple deletion confirmed with another Apple Account or failed at Apple keeps the account active", async ({
  expectConsoleError,
  page,
  workerEnvironment,
}) => {
  const { origin, authProvider } = workerEnvironment;
  await signInFromLink(page, origin, "Apple");
  await page.goto(`${origin}/app/recent/account`);
  const confirmWithApple = async () => {
    await page.getByRole("button", { name: "Delete account…", exact: true }).click();
    await page
      .getByRole("region", { name: "Confirm account change" })
      .getByRole("button", { name: "Continue with Apple", exact: true })
      .click();
    await scheduleDeletion(page);
  };

  authProvider.setAppleTokenSubject("000999.other-apple.0789");
  await confirmWithApple();
  await expect(page.getByRole("alert")).toHaveText(
    "Use the Apple Account linked to this Cup account.",
  );
  authProvider.setAppleTokenSubject(undefined);
  authProvider.setAppleFailure("/auth/revoke");
  await confirmWithApple();
  await expect(page.getByRole("alert")).toHaveText(
    "Apple couldn't confirm the deletion. Your account is still active, and nothing will be deleted. Try again.",
  );

  expect((await readAccount(page, origin)).state).toBe("active");
  expect(authProvider.appleRequests().map(({ path }) => path)).toStrictEqual([
    "/auth/token",
    "/auth/token",
    "/auth/revoke",
  ]);
  expectConsoleError(/^Failed to load resource: the server responded with a status of 409/);
  expectConsoleError(/^Failed to load resource: the server responded with a status of 503/);
});

test("an Apple-linked account scheduled for deletion is recovered with Apple, and again with Google", async ({
  page,
  workerEnvironment,
}) => {
  test.setTimeout(60_000);
  const { origin, authProvider } = workerEnvironment;
  await signInFromLink(page, origin, "Google");
  await signInFromLink(page, origin, "Apple");
  const deleteWithApple = async () => {
    await page.goto(`${origin}/app/recent/account`);
    await page.getByRole("button", { name: "Delete account…", exact: true }).click();
    await page
      .getByRole("region", { name: "Confirm account change" })
      .getByRole("button", { name: "Continue with Apple", exact: true })
      .click();
    await scheduleDeletion(page);
    await expect(page).toHaveURL(`${origin}/app/`);
  };
  const recoverWith = async (method: "Apple" | "Google") => {
    await page.goto(`${origin}/app/account-recovery`);
    await page.getByRole("button", { name: `Continue with ${method}`, exact: true }).click();
    await page.getByRole("button", { name: "Restore account…", exact: true }).click();
    const confirmation = page.getByRole("region", { name: "Confirm account change" });
    await expect(confirmation.getByRole("button")).toHaveText([
      "Continue with Apple",
      "Continue with Google",
      "Cancel",
    ]);
    await confirmation
      .getByRole("button", { name: `Continue with ${method}`, exact: true })
      .click();
    const restored = page.waitForRequest(
      (request) =>
        request.method() === "POST" &&
        new URL(request.url()).pathname === "/api/account/deletion/restore",
    );
    await page.getByRole("button", { name: "Confirm recovery", exact: true }).click();
    await expect(
      page.getByText(
        "Your account is restored. Your existing minutes and conversions are available again.",
      ),
    ).toBeVisible();
    return (await restored).postDataJSON();
  };

  await deleteWithApple();
  expect(await recoverWith("Apple")).not.toHaveProperty("providerCredential");
  expect((await readAccount(page, origin)).state).toBe("active");
  await deleteWithApple();
  await recoverWith("Google");

  expect((await readAccount(page, origin)).state).toBe("active");
  expect(
    authProvider
      .appleRequests()
      .filter(({ path }) => path === "/auth/revoke")
      .map(({ path }) => path),
  ).toStrictEqual(["/auth/revoke", "/auth/revoke", "/auth/revoke", "/auth/revoke"]);
});

test("Apple sign-ins during the seven days are revoked at Apple, the one that confirms recovery too", async ({
  page,
  workerEnvironment,
}) => {
  test.setTimeout(60_000);
  const { origin, authProvider } = workerEnvironment;
  const revokedTokens = () =>
    authProvider
      .appleRequests()
      .filter(({ path }) => path === "/auth/revoke")
      .map(({ token }) => token);
  await signInFromLink(page, origin, "Apple");
  await page.goto(`${origin}/app/recent/account`);
  await page.getByRole("button", { name: "Delete account…", exact: true }).click();
  await page
    .getByRole("region", { name: "Confirm account change" })
    .getByRole("button", { name: "Continue with Apple", exact: true })
    .click();
  await scheduleDeletion(page);
  await expect(page).toHaveURL(`${origin}/app/`);
  expect(revokedTokens()).toHaveLength(1);

  await page.goto(`${origin}/app/account-recovery`);
  await page.getByRole("button", { name: "Continue with Apple", exact: true }).click();
  await expect.poll(revokedTokens).toHaveLength(2);
  expect((await readAccount(page, origin)).state).toBe("deletion_scheduled");

  await page.getByRole("button", { name: "Restore account…", exact: true }).click();
  await page
    .getByRole("region", { name: "Confirm account change" })
    .getByRole("button", { name: "Continue with Apple", exact: true })
    .click();
  await page.getByRole("button", { name: "Confirm recovery", exact: true }).click();
  await expect(
    page.getByText(
      "Your account is restored. Your existing minutes and conversions are available again.",
    ),
  ).toBeVisible();

  expect((await readAccount(page, origin)).state).toBe("active");
  const tokens = revokedTokens();
  expect(new Set(tokens).size).toBe(3);
  expect(
    authProvider
      .appleRequests()
      .filter(({ token }) => token === tokens[2])
      .map(({ path, clientId }) => ({ path, clientId })),
  ).toStrictEqual([
    { path: "/auth/token", clientId: "audio.cup.app.web" },
    { path: "/auth/revoke", clientId: "audio.cup.app.web" },
  ]);
});

async function signInFromLink(page: Page, origin: string, method: "Apple" | "Google") {
  await page.goto(`${origin}/app/`);
  await page.evaluate(() => localStorage.removeItem("cup_supabase_session"));
  await page.reload();
  await page.getByRole("link", { name: "Sign in", exact: true }).click();
  await page
    .getByRole("dialog", { name: "Sign in", exact: true })
    .getByRole("button", { name: `Continue with ${method}`, exact: true })
    .click();
  await expect(page).toHaveURL(`${origin}/app/recent`);
}

async function scheduleDeletion(page: Page) {
  const confirm = page.getByRole("button", { name: "Schedule deletion", exact: true });
  await expect(confirm).toBeVisible();
  await expect
    .poll(() =>
      page
        .locator("img")
        .evaluateAll((images) =>
          images.every((image) => image instanceof HTMLImageElement && image.complete),
        ),
    )
    .toBe(true);
  await confirm.click();
}

function claimsOf(accessToken: string): unknown {
  return JSON.parse(Buffer.from(accessToken.split(".")[1] ?? "", "base64url").toString());
}

async function readAccount(page: Page, origin: string) {
  const accessToken = await readAccessToken(page);
  const response = await page.request.get(`${origin}/api/account`, {
    headers: { Authorization: `Bearer ${accessToken}` },
  });
  expect(response.ok()).toBe(true);
  return accountSnapshotSchema.parse(await response.json());
}

test("a rate-limited resumed conversion waits for explicit retry and keeps its idempotency key", async ({
  expectConsoleError,
  page,
  workerEnvironment,
}) => {
  const { origin } = workerEnvironment;
  const keys: Array<string | undefined> = [];
  await page.route("**/api/account/conversions", (route) => {
    if (route.request().method() !== "POST") {
      return route.continue();
    }
    keys.push(route.request().headers()["idempotency-key"]);
    if (keys.length > 1) {
      return route.continue();
    }
    expectConsoleError(/^Failed to load resource: the server responded with a status of 429/);
    return route.fulfill({
      status: 429,
      headers: { "Retry-After": "1" },
      json: { error: { message: "Try again shortly." } },
    });
  });
  await page.goto(`${origin}/app/`);
  await page.getByRole("textbox", { name: "URL", exact: true }).fill(SOURCE_URL);
  await page.getByRole("button", { name: "Listen" }).click();
  await page.getByRole("button", { name: "Continue with Google", exact: true }).click();
  await expect(page.getByRole("alert")).toHaveText("Try again shortly.");
  await page.reload();
  await expect(page.getByRole("textbox", { name: "URL", exact: true })).toHaveValue(SOURCE_URL);
  await expect(page.getByRole("button", { name: "Listen" })).toBeEnabled();
  expect(keys).toHaveLength(1);
  await page.getByRole("button", { name: "Listen" }).click();
  await expect(page).toHaveURL(/\/app\/audiobooks\//, { timeout: 60_000 });
  expect(keys[0]).toBeTruthy();
  expect(keys).toEqual([keys[0], keys[0]]);
});

test("account positions restore once and use last-write-wins across players", async ({
  page,
  workerEnvironment,
}) => {
  const { origin } = workerEnvironment;
  await page.goto(origin + "/app/");
  await page.getByRole("textbox", { name: "URL", exact: true }).fill(SOURCE_URL);
  await page.getByRole("button", { name: "Listen" }).click();
  await page.getByRole("button", { name: "Continue with Google", exact: true }).click();
  await expect(page).toHaveURL(/\/app\/audiobooks\//, { timeout: 60000 });
  await waitForAudiobook(page);
  const url = page.url();
  const id = new URL(url).pathname.split("/").at(-1)!;
  const token = await readAccessToken(page);
  await waitForGeneratedAudio(page, id, token);
  const document = await readAudiobook(page, id, token);
  if (document.status !== "ready") {
    throw new Error("Article not prepared");
  }
  const unitId = document.narrationDocument.synchronizationUnits[1]!.id;
  const save = await page.evaluate(
    async (input) => {
      return (
        await fetch(`/api/audiobooks/${input.id}/position`, {
          method: "PUT",
          headers: {
            "Content-Type": "application/json",
            "X-Create-Audiobook-From-URL-Request": "1",
            Authorization: `Bearer ${input.token}`,
          },
          body: JSON.stringify({ synchronizationUnitId: input.unitId, offsetMilliseconds: 1200 }),
        })
      ).status;
    },
    { id, token, unitId },
  );
  expect(save).toBe(204);
  await page.reload();
  await waitForAudiobook(page);
  await expect(page.locator(`[data-synchronization-unit="${unitId}"]`)).toHaveAttribute(
    "aria-current",
    "true",
  );
  await page.getByRole("button", { name: "Play", exact: true }).click();
  await expect(page.getByRole("button", { name: "Pause", exact: true })).toBeVisible();
  await page.getByRole("button", { name: "Pause", exact: true }).click();
  await expect(page.locator(`[data-synchronization-unit="${unitId}"]`)).toHaveAttribute(
    "aria-current",
    "true",
  );
  const second = await page.context().newPage();
  await second.goto(url);
  await waitForAudiobook(second);
  await expect(second.locator(`[data-synchronization-unit="${unitId}"]`)).toHaveAttribute(
    "aria-current",
    "true",
  );
  await second
    .locator(
      `[data-synchronization-unit="${document.narrationDocument.synchronizationUnits[2]!.id}"]`,
    )
    .click();
  await expect(second.getByRole("button", { name: "Pause", exact: true })).toBeVisible();
  await second.getByRole("button", { name: "Pause", exact: true }).click();
  await expect
    .poll(async () => {
      const result = await page.request.get(origin + "/api/audiobooks/" + id, {
        headers: { Authorization: `Bearer ${token}` },
      });
      return (await result.json()).playbackPosition?.synchronizationUnitId;
    })
    .toBe(document.narrationDocument.synchronizationUnits[2]!.id);
  await expect(page.locator(`[data-synchronization-unit="${unitId}"]`)).toHaveAttribute(
    "aria-current",
    "true",
  );
  await page.reload();
  await waitForAudiobook(page);
  await expect(
    page.locator(
      `[data-synchronization-unit="${document.narrationDocument.synchronizationUnits[2]!.id}"]`,
    ),
  ).toHaveAttribute("aria-current", "true");
  await expect
    .poll(async () => (await (await fetch(origin + "/__qa/speech-calls")).json()).length)
    .toBe(document.narrationDocument.synchronizationUnits.length);
  await second.close();
});

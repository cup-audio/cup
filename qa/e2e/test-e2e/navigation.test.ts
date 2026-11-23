import type { Page } from "@playwright/test";

import { readLoadingStateRecord, recordLoadingStates } from "@cup/loading-state-recorder";

import { expect, test } from "#test-e2e/fixtures.ts";
import { readAccessToken, waitForAudiobook } from "#test-e2e/journey.ts";
import { waitForGeneratedAudio } from "#test-e2e/synthesis.ts";

const SOURCE_URL = "https://source.example.test/fixture";
const HISTORY_PATH = "/api/account/conversions";

test("Recents and a track opened again show their cached content while each is requested again", async ({
  page,
  workerEnvironment,
}) => {
  const { origin } = workerEnvironment;
  await page.goto(`${origin}/app/`);
  await page.getByRole("textbox", { name: "URL", exact: true }).fill(SOURCE_URL);
  await page.getByRole("button", { name: "Listen" }).click();
  await page.getByRole("button", { name: "Continue with Google", exact: true }).click();
  await expect(page).toHaveURL(/\/app\/audiobooks\//, { timeout: 60_000 });
  const conversionId = new URL(page.url()).pathname.split("/").at(-1);
  if (!conversionId) {
    throw new Error("Conversion missing");
  }
  const audiobookPath = `/api/audiobooks/${conversionId}`;
  await waitForGeneratedAudio(page, conversionId, await readAccessToken(page));

  await recordLoadingStates(page);
  await page.clock.install();
  const isPreloaded = page.waitForResponse((response) => {
    return new URL(response.url()).pathname === audiobookPath;
  });
  await page.goto(`${origin}/app/recent`);
  const track = page.getByRole("list", { name: "Tracks" }).getByRole("link");
  await expect(track).toHaveCount(1);
  await isPreloaded;
  const recordedOnColdStart = (await readLoadingStateRecord(page)).length;
  const isHistoryRefreshed = page.waitForResponse((response) => {
    return new URL(response.url()).pathname === HISTORY_PATH;
  });
  await track.click();
  await waitForAudiobook(page);
  await isHistoryRefreshed;
  await stayAway(page);

  const historyRequests = await holdRequests(page, (pathname) => pathname === HISTORY_PATH);
  await page.getByRole("link", { name: "Back", exact: true }).click();
  await expect(page).toHaveURL(`${origin}/app/recent`);
  await expect.poll(historyRequests.countHeld).toBeGreaterThan(0);
  await expect(track).toHaveCount(1);
  await stayAway(page);

  const audiobookRequests = await holdRequests(page, (pathname) => pathname === audiobookPath);
  await track.click();
  await expect.poll(audiobookRequests.countHeld).toBeGreaterThan(0);
  await waitForAudiobook(page);

  expect((await readLoadingStateRecord(page)).slice(recordedOnColdStart)).toEqual([]);
  historyRequests.release();
  audiobookRequests.release();
});

async function holdRequests(page: Page, isHeld: (pathname: string) => boolean) {
  const { promise: released, resolve: release } = Promise.withResolvers<void>();
  let heldCount = 0;
  await page.route("**/api/**", async (route) => {
    if (route.request().method() !== "GET" || !isHeld(new URL(route.request().url()).pathname)) {
      await route.fallback();
      return;
    }
    heldCount += 1;
    await released;
    await route.fallback();
  });
  return { countHeld: () => heldCount, release: () => release() };
}

async function stayAway(page: Page) {
  await page.clock.fastForward(5_000);
}

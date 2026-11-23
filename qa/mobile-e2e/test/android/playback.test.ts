import timers from "node:timers/promises";
import { expect, test } from "vitest";

import {
  asAndroidAppDevice,
  type AndroidAppDevice,
  type AndroidLaunchArguments,
} from "#src/android/android-app-device.ts";
import { useMobileApp } from "#src/fixtures.ts";
import { signInFromLandingPage, waitForLandingPage, waitForRecents } from "#src/journeys.ts";

const app = useMobileApp();

const APP_PACKAGE = "audio.cup.app";
const PLAYER = 'footer[aria-label="Player"]';
const SKIP_MILLISECONDS = 15_000;
const SAVE_INTERVAL_MILLISECONDS = 5_000;
const SAVE_WAIT_MILLISECONDS = 20_000;
const MP3_SEEK_TOLERANCE_MILLISECONDS = 100;
const POSITION_TOLERANCE_MILLISECONDS = 2_500;
const LOCKED_LISTEN_MILLISECONDS = 120_000;
const LOCKED_SAVE_INTERVAL_LIMIT_MILLISECONDS = 7_000;
const LOCKED_CHECK_INTERVAL_MILLISECONDS = 20_000;
const SHORT_URL_LIFETIME_SECONDS = 30;
const TRACK_BYTES_PER_SECOND = 32_000;
const MEDIA_ERROR_MESSAGE = "Audio could not be played. Press Play to try again.";
const FOREGROUND_GRACE_SECONDS = 10;

test("the first Play starts a foreground media session that shows the audiobook and its position", async () => {
  const device = asAndroidAppDevice(app.device);
  const { webView, title, durationMilliseconds, conversionId } = await openNewAudiobook(device);

  await webView.$(`${PLAYER} button[aria-label="Forward 15 seconds"]`).click();
  await expect.poll(() => readPosition(webView)).toBe(SKIP_MILLISECONDS);
  await waitForSaveAfter(conversionId, 0);
  expect(await cupMediaSession(device)).toBeUndefined();
  expect(await cupMediaPlaybackService(device)).toBeUndefined();

  await webView.$(`${PLAYER} button[aria-label="Play"]`).click();
  await waitForPlayButton(webView, "Pause");

  const session = await waitForCupMediaSession(device, "PLAYING");
  expect(session).toContain(`description=${title}, `);
  expect(await cupMediaPlaybackService(device)).toMatch(
    /\bisForeground=true\b.*\btypes=0x00000002\b/u,
  );
  await expect
    .poll(() => cupMediaNotification(device), { timeout: 10_000 })
    .toMatch(/\bandroid\.largeIcon=Icon \(Icon\(typ=BITMAP/u);
  expect(await cupMediaNotification(device)).toMatch(/\bandroid\.text=String \(Cup\)/u);

  await expect
    .poll(() => readPosition(webView), { timeout: 15_000 })
    .toBeGreaterThan(SKIP_MILLISECONDS + 3_000);

  const progress = await device.readMediaControlsProgress();
  const pagePosition = await readPosition(device.webView());
  const [shownPositionSeconds, shownDurationSeconds] = parseProgress(progress);
  expect(Math.abs(shownDurationSeconds * 1_000 - durationMilliseconds)).toBeLessThan(1_000);
  expect(Math.abs(shownPositionSeconds * 1_000 - pagePosition)).toBeLessThan(
    POSITION_TOLERANCE_MILLISECONDS + 1_000,
  );
});

test("media keys and the notification's buttons and seek bar act on the player without the page, and each saves the position", async () => {
  const device = asAndroidAppDevice(app.device);
  const opened = await openNewAudiobook(device);
  const { conversionId } = opened;
  let { webView } = opened;
  const unitIds = await readUnitIds(webView);
  await webView.$(`${PLAYER} button[aria-label="Play"]`).click();
  await waitForCupMediaSession(device, "PLAYING");

  let saveCount = positionSaves(conversionId).length;
  await device.pressMediaKey("KEYCODE_MEDIA_PAUSE");
  await waitForPlayButton(webView, "Play");
  await waitForCupMediaSession(device, "PAUSED");
  await waitForSaveAfter(conversionId, saveCount);
  await device.pressMediaKey("KEYCODE_MEDIA_PLAY");
  await waitForPlayButton(webView, "Pause");
  saveCount = positionSaves(conversionId).length;
  await device.pressMediaKey("KEYCODE_MEDIA_PAUSE");
  await waitForPlayButton(webView, "Play");
  const pauseSave = await waitForSaveAfter(conversionId, saveCount);

  const pausedAt = await readPosition(webView);
  saveCount = positionSaves(conversionId).length;
  await device.tapMediaControl("Forward 15 seconds");
  webView = await device.webView();
  await expectPositionNear(webView, pausedAt + SKIP_MILLISECONDS);
  const forwardSave = await waitForSaveAfter(conversionId, saveCount);
  expect(compareSaves(unitIds, forwardSave, pauseSave)).toBeGreaterThan(0);

  saveCount = positionSaves(conversionId).length;
  await device.tapMediaControl("Back 15 seconds");
  webView = await device.webView();
  await expectPositionNear(webView, pausedAt);
  const backSave = await waitForSaveAfter(conversionId, saveCount);
  expect(unitIds).toContain(backSave.synchronizationUnitId);
  const unitOrder =
    unitIds.indexOf(backSave.synchronizationUnitId) -
    unitIds.indexOf(pauseSave.synchronizationUnitId);
  const millisecondsAfterPauseSave =
    unitOrder === 0
      ? backSave.offsetMilliseconds - pauseSave.offsetMilliseconds
      : Math.sign(unitOrder) * Number.POSITIVE_INFINITY;
  expect(millisecondsAfterPauseSave).toBeGreaterThan(-MP3_SEEK_TOLERANCE_MILLISECONDS);

  saveCount = positionSaves(conversionId).length;
  await device.tapMediaControl("Forward 15 seconds");
  const secondForwardSave = await waitForSaveAfter(conversionId, saveCount);
  expect(secondForwardSave.synchronizationUnitId).toBe(forwardSave.synchronizationUnitId);
  expect(
    Math.abs(secondForwardSave.offsetMilliseconds - forwardSave.offsetMilliseconds),
  ).toBeLessThan(MP3_SEEK_TOLERANCE_MILLISECONDS);
  saveCount = positionSaves(conversionId).length;
  await device.tapMediaControl("Back 15 seconds");
  await waitForSaveAfter(conversionId, saveCount);
  webView = await device.webView();

  const durationMilliseconds = await readDuration(webView);
  saveCount = positionSaves(conversionId).length;
  await device.dragMediaControlsSeekBar(0.75);
  webView = await device.webView();
  await expect
    .poll(() => readPosition(webView), { timeout: 10_000 })
    .toBeGreaterThan(durationMilliseconds * 0.5);
  expect(
    compareSaves(unitIds, await waitForSaveAfter(conversionId, saveCount), pauseSave),
  ).toBeGreaterThan(0);
  await waitForPlayButton(webView, "Play");
});

test("Close in the notification ends a playing session, which saves the position, and the page keeps it", async () => {
  const device = asAndroidAppDevice(app.device);
  await app.worker.restart("long-speech");
  const { webView, conversionId, durationMilliseconds } = await openNewAudiobook(device);
  expect(durationMilliseconds).toBeGreaterThan(120_000);
  await recordPlayButtonLabels(webView);
  await webView.$(`${PLAYER} button[aria-label="Play"]`).click();
  await waitForCupMediaSession(device, "PLAYING");
  await expect.poll(() => readPosition(webView), { timeout: 15_000 }).toBeGreaterThan(3_000);
  expect(await readPlayButtonLabels(webView)).toEqual(["Play", "Pause"]);

  const saveCount = positionSaves(conversionId).length;
  await device.tapMediaControl("Close");
  await waitForSessionToEnd(device, 15_000);
  await waitForSaveAfter(conversionId, saveCount);

  const page = await device.webView();
  await waitForPlayButton(page, "Play");
  const keptAt = await readPosition(page);
  expect(keptAt).toBeGreaterThan(3_000);
  await page.$(`${PLAYER} button[aria-label="Play"]`).click();
  await waitForCupMediaSession(device, "PLAYING");
});

test(
  "a listen with the screen off and Cup in the background keeps playing and saving in an unfrozen process",
  { timeout: LOCKED_LISTEN_MILLISECONDS + 240_000 },
  async () => {
    const device = asAndroidAppDevice(app.device);
    await app.worker.restart("long-speech");
    const opened = await openNewAudiobook(device);
    const { conversionId } = opened;
    let { webView } = opened;
    expect(await readDuration(webView)).toBeGreaterThan(LOCKED_LISTEN_MILLISECONDS + 30_000);
    await webView.$(`${PLAYER} button[aria-label="Play"]`).click();
    await waitForPlayButton(webView, "Pause");
    await waitForCupMediaSession(device, "PLAYING");
    const startPosition = await readPosition(webView);

    await device.background();
    await device.turnScreenOff();
    try {
      const savesBefore = positionSaves(conversionId).length;
      const lockedAt = performance.now();
      for (
        let elapsed = 0;
        elapsed < LOCKED_LISTEN_MILLISECONDS;
        elapsed += LOCKED_CHECK_INTERVAL_MILLISECONDS
      ) {
        await timers.setTimeout(LOCKED_CHECK_INTERVAL_MILLISECONDS);
        expect(await device.isFrozen()).toBe(false);
        expect(await cupMediaPlaybackService(device)).toMatch(/\bisForeground=true\b/u);
      }
      expect(await cupMediaSession(device)).toMatch(/\bstate=PlaybackState \{state=PLAYING\(3\)/u);
      const lockedSaves = positionSaves(conversionId).length - savesBefore;
      const lockedMilliseconds = performance.now() - lockedAt;
      expect(lockedSaves).toBeGreaterThanOrEqual(
        Math.floor(lockedMilliseconds / LOCKED_SAVE_INTERVAL_LIMIT_MILLISECONDS) - 1,
      );
      expect(lockedSaves).toBeLessThanOrEqual(
        Math.ceil(lockedMilliseconds / SAVE_INTERVAL_MILLISECONDS) + 1,
      );
    } finally {
      await device.turnScreenOnAndUnlock();
    }
    await device.bringToForeground();
    webView = await device.webView();
    await expect
      .poll(() => readPosition(webView), { timeout: 10_000 })
      .toBeGreaterThan(startPosition + LOCKED_LISTEN_MILLISECONDS - 10_000);
    await waitForPlayButton(webView, "Pause");
  },
);

test("a call and transient audio focus requests pause the player and resume it, and a duck request pauses it", async () => {
  const device = asAndroidAppDevice(app.device);
  const { webView } = await openNewAudiobook(device);
  await webView.$(`${PLAYER} button[aria-label="Play"]`).click();
  await waitForPlayButton(webView, "Pause");
  await waitForCupMediaSession(device, "PLAYING");

  await device.emulatorConsole("gsm", "call", "5551234");
  await waitForPlayButton(webView, "Play");
  await device.emulatorConsole("gsm", "cancel", "5551234");
  await waitForPlayButton(webView, "Pause");

  await device.probeAudioFocus("transient");
  await waitForPlayButton(webView, "Play");
  await device.probeAudioFocus("abandon");
  await waitForPlayButton(webView, "Pause");

  await device.probeAudioFocus("duck");
  await waitForPlayButton(webView, "Play");
  await device.probeAudioFocus("abandon");
  await waitForPlayButton(webView, "Pause");
  expect(await waitForCupMediaSession(device, "PLAYING")).toContain(`package=${APP_PACKAGE}`);
});

test("expired URLs end a paused session, and the next Play renews them and plays from where it stopped", async () => {
  const device = asAndroidAppDevice(app.device);
  await app.worker.restart("success", { signedUrlLifetimeSeconds: SHORT_URL_LIFETIME_SECONDS });
  const opened = await openNewAudiobook(device, {
    signedUrlLifetimeSeconds: SHORT_URL_LIFETIME_SECONDS,
  });
  const { conversionId } = opened;
  let { webView } = opened;
  await webView.$(`${PLAYER} button[aria-label="Play"]`).click();
  await waitForCupMediaSession(device, "PLAYING");
  await webView.$(`${PLAYER} button[aria-label="Pause"]`).click();
  await waitForCupMediaSession(device, "PAUSED");
  const pausedAt = await readPosition(webView);

  await waitForSessionToEnd(device, (SHORT_URL_LIFETIME_SECONDS + 30) * 1_000);
  webView = await device.webView();
  await waitForPlayButton(webView, "Play");
  await expectPositionNear(webView, pausedAt);

  const fetchesBefore = audiobookFetches(conversionId);
  await webView.$(`${PLAYER} button[aria-label="Play"]`).click();
  await waitForPlayButton(webView, "Pause");
  await waitForCupMediaSession(device, "PLAYING");
  expect(audiobookFetches(conversionId)).toBeGreaterThan(fetchesBefore);
  expect(await readPosition(webView)).toBeGreaterThanOrEqual(
    pausedAt - POSITION_TOLERANCE_MILLISECONDS,
  );
});

test("a track URL the server refuses ends the playing session, and the next Play renews it and plays", async () => {
  const device = asAndroidAppDevice(app.device);
  await app.worker.restart("long-speech", { signedUrlLifetimeSeconds: SHORT_URL_LIFETIME_SECONDS });
  const opened = await openNewAudiobook(device);
  const { conversionId } = opened;
  let { webView } = opened;
  await webView.$(`${PLAYER} button[aria-label="Play"]`).click();
  await waitForCupMediaSession(device, "PLAYING");

  await timers.setTimeout((SHORT_URL_LIFETIME_SECONDS + 5) * 1_000);
  const fourthUnitId = (await readUnitIds(webView))[3]!;
  const [fourthUnitHeading] = await webView.$$(`[data-synchronization-unit="${fourthUnitId}"]`);
  await fourthUnitHeading!.click();
  await waitForSessionToEnd(device, 30_000);
  webView = await device.webView();
  await waitForPlayButton(webView, "Play");

  const fetchesBefore = audiobookFetches(conversionId);
  await webView.$(`${PLAYER} button[aria-label="Play"]`).click();
  await waitForPlayButton(webView, "Pause");
  await waitForCupMediaSession(device, "PLAYING");
  expect(audiobookFetches(conversionId)).toBeGreaterThan(fetchesBefore);
});

test("a lost connection pauses the player with an error, and Play from the notification or the page continues where it stopped", async () => {
  const device = asAndroidAppDevice(app.device);
  await app.worker.restart("long-speech", { trackBytesPerSecond: TRACK_BYTES_PER_SECOND });
  let { webView } = await openNewAudiobook(device);
  await webView.$(`${PLAYER} button[aria-label="Play"]`).click();
  await waitForCupMediaSession(device, "PLAYING");
  await expect.poll(() => readPosition(webView), { timeout: 15_000 }).toBeGreaterThan(2_000);

  let failedAt = await loseConnectionUntilPlaybackFails(device, webView);
  await device.tapMediaControl("Play");
  webView = await device.webView();
  await expectToPlayOnFrom(device, webView, failedAt);

  failedAt = await loseConnectionUntilPlaybackFails(device, webView);
  await webView.$(`${PLAYER} button[aria-label="Play"]`).click();
  await expectToPlayOnFrom(device, webView, failedAt);
});

test("a playing session survives a swipe from recents and keeps saving, reopening Cup takes it over, and a swipe while paused ends it", async () => {
  const device = asAndroidAppDevice(app.device);
  await app.worker.restart("long-speech");
  const opened = await openNewAudiobook(device);
  const { conversionId } = opened;
  let { webView } = opened;
  await webView.$(`${PLAYER} button[aria-label="Play"]`).click();
  await waitForPlayButton(webView, "Pause");
  await waitForCupMediaSession(device, "PLAYING");
  await expect.poll(() => readPosition(webView), { timeout: 15_000 }).toBeGreaterThan(3_000);
  const swipedAt = await readPosition(webView);

  const savesBeforeSwipe = positionSaves(conversionId).length;
  await device.removeFromRecents();
  await expect
    .poll(() => positionSaves(conversionId).length, {
      timeout: 3 * SAVE_INTERVAL_MILLISECONDS,
      message: "The plugin saved nothing after the swipe.",
    })
    .toBeGreaterThanOrEqual(savesBeforeSwipe + 2);
  expect(await cupMediaSession(device)).toMatch(/\bstate=PlaybackState \{state=PLAYING\(3\)/u);
  expect(await cupMediaPlaybackService(device)).toMatch(/\bisForeground=true\b/u);

  await device.reopen();
  webView = await device.webView();
  await webView
    .$('[aria-label="Player"] button[aria-label="Pause"]')
    .waitForExist({ timeout: 30_000, timeoutMsg: "The page did not take the session over." });
  const miniPlayerLink = webView.$('section[aria-label="Player"] a');
  if (await miniPlayerLink.isExisting()) {
    await miniPlayerLink.click();
  }
  await waitForPlayButton(webView, "Pause");
  await expect
    .poll(() => readPosition(webView), { timeout: 10_000 })
    .toBeGreaterThan(swipedAt + 5_000);
  expect(await cupMediaSession(device)).toMatch(/\bstate=PlaybackState \{state=PLAYING\(3\)/u);

  const savesBeforePause = positionSaves(conversionId).length;
  await webView.$(`${PLAYER} button[aria-label="Pause"]`).click();
  await waitForCupMediaSession(device, "PAUSED");
  await waitForSaveAfter(conversionId, savesBeforePause);
  await device.removeFromRecents();
  await waitForSessionToEnd(device, 15_000);
});

test("a session a call pauses survives a swipe from recents and plays on after the call", async () => {
  const device = asAndroidAppDevice(app.device);
  await app.worker.restart("long-speech");
  const { webView } = await openNewAudiobook(device);
  await webView.$(`${PLAYER} button[aria-label="Play"]`).click();
  await waitForCupMediaSession(device, "PLAYING");

  await device.emulatorConsole("gsm", "call", "5551234");
  try {
    await waitForCupMediaSession(device, "PAUSED");
    await device.removeFromRecents();
    await timers.setTimeout(5_000);
    expect(await cupMediaPlaybackService(device)).toBeDefined();
  } finally {
    await device.emulatorConsole("gsm", "cancel", "5551234");
  }
  await waitForCupMediaSession(device, "PLAYING");
});

test("signing out saves the position one last time through the position URL and ends the session", async () => {
  const device = asAndroidAppDevice(app.device);
  await app.worker.restart("long-speech");
  const opened = await openNewAudiobook(device);
  const { conversionId } = opened;
  let { webView } = opened;
  await webView.$(`${PLAYER} button[aria-label="Play"]`).click();
  await waitForCupMediaSession(device, "PLAYING");

  const signingOut = await startSigningOut(device, webView);
  webView = signingOut.webView;
  expect(await cupMediaPlaybackService(device)).toBeDefined();
  const savesBeforeSignOut = positionSaves(conversionId).length;
  await signingOut.scheduleDeletion.click();
  await waitForLandingPage(webView);

  await waitForSessionToEnd(device, 15_000);
  await waitForSaveAfter(conversionId, savesBeforeSignOut);
});

test(
  "a position the native stop could not save is saved when the listener signs out",
  { timeout: 360_000 },
  async () => {
    const device = asAndroidAppDevice(app.device);
    await app.worker.restart("long-speech");
    const opened = await openNewAudiobook(device, {
      foregroundGraceSeconds: FOREGROUND_GRACE_SECONDS,
    });
    const { conversionId } = opened;
    const { webView } = opened;
    await webView.$(`${PLAYER} button[aria-label="Play"]`).click();
    await waitForCupMediaSession(device, "PLAYING");
    await expect.poll(() => readPosition(webView), { timeout: 15_000 }).toBeGreaterThan(3_000);

    const workerPort = Number(new URL(app.apiOrigin).port);
    let savesBeforeSignOut: number;
    await device.unexposeHostPort(workerPort);
    try {
      await app.worker.restart("long-speech");
      savesBeforeSignOut = positionSaves(conversionId).length;
      await device.pressMediaKey("KEYCODE_MEDIA_PAUSE");
      await waitForPlayButton(webView, "Play");
      await device.background();
      await waitForServiceToLeaveTheForeground(device);
      await device.hideMediaControls();
      await waitForSessionToEnd(device, 15_000);
    } finally {
      await device.exposeHostPort(workerPort);
    }
    await timers.setTimeout(5_000);
    expect(positionSaves(conversionId)).toHaveLength(savesBeforeSignOut);

    await device.bringToForeground();
    const signingOut = await startSigningOut(device, await device.webView());
    await signingOut.scheduleDeletion.click();
    await waitForLandingPage(signingOut.webView);
    await waitForSaveAfter(conversionId, savesBeforeSignOut);
  },
);

test(
  "after the foreground grace a paused session keeps its notification, whose Play works, and hiding it ends the session",
  { timeout: 360_000 },
  async () => {
    const device = asAndroidAppDevice(app.device);
    await app.worker.restart("long-speech");
    let { webView } = await openNewAudiobook(device, {
      foregroundGraceSeconds: FOREGROUND_GRACE_SECONDS,
    });
    await webView.$(`${PLAYER} button[aria-label="Play"]`).click();
    await waitForCupMediaSession(device, "PLAYING");

    await device.pressMediaKey("KEYCODE_MEDIA_PAUSE");
    await device.background();
    await waitForServiceToLeaveTheForeground(device);
    await waitForCupMediaSession(device, "PAUSED");
    expect(await cupMediaNotification(device)).toContain(`pkg=${APP_PACKAGE} `);

    await device.tapMediaControl("Play");
    await waitForCupMediaSession(device, "PLAYING");
    expect(await cupMediaPlaybackService(device)).toMatch(/\bisForeground=true\b/u);

    await device.emulatorConsole("gsm", "call", "5551234");
    await waitForCupMediaSession(device, "PAUSED");
    await timers.setTimeout((FOREGROUND_GRACE_SECONDS + 5) * 1_000);
    expect(await cupMediaPlaybackService(device)).toMatch(/\bisForeground=true\b/u);
    await device.emulatorConsole("gsm", "cancel", "5551234");
    await waitForCupMediaSession(device, "PLAYING");

    await device.pressMediaKey("KEYCODE_MEDIA_PAUSE");
    await waitForCupMediaSession(device, "PAUSED");
    await waitForServiceToLeaveTheForeground(device);
    await device.bringToForeground();
    webView = await device.webView();
    const pausedAt = await readPosition(webView);
    await device.background();
    await device.hideMediaControls();
    await waitForSessionToEnd(device, 15_000);

    await device.bringToForeground();
    webView = await device.webView();
    await waitForPlayButton(webView, "Play");
    await expectPositionNear(webView, pausedAt);
    await webView.$(`${PLAYER} button[aria-label="Play"]`).click();
    await waitForPlayButton(webView, "Pause");
    await waitForCupMediaSession(device, "PLAYING");
  },
);

async function openNewAudiobook(
  device: AndroidAppDevice,
  launchArguments: Omit<AndroidLaunchArguments, "apiOrigin"> = {},
) {
  await device.launch({ apiOrigin: app.apiOrigin, ...launchArguments });
  const webView = await device.webView();
  await signInFromLandingPage(device, webView);
  await webView.$(`${PLAYER} button[aria-label="Play"]`).waitForEnabled({ timeout: 120_000 });
  const title = await webView.execute(() => document.querySelector("h1")?.textContent ?? "");
  const durationMilliseconds = await readDuration(webView);
  expect(title).not.toBe("");
  expect(durationMilliseconds).toBeGreaterThan(5_000);
  const pathname = await webView.execute(() => location.pathname);
  const conversionId = /^\/app\/audiobooks\/([^/]+)/u.exec(pathname)?.[1];
  if (conversionId === undefined) {
    throw new Error(`The audiobook's page has no conversion in its path: ${pathname}`);
  }
  return { webView, title, durationMilliseconds, conversionId };
}

async function startSigningOut(device: AndroidAppDevice, webView: WebdriverIO.Browser) {
  await webView.$('a[aria-label="Back"]').click();
  await waitForRecents(webView, 1);
  await webView.$('a[aria-label="Account"]').click();
  await webView.$("button=Delete account…").click();
  await device.continueGoogleSignIn();
  const signedInWebView = await device.webView();
  const scheduleDeletion = signedInWebView.$("button=Schedule deletion");
  await scheduleDeletion.waitForEnabled({ timeout: 30_000 });
  return { webView: signedInWebView, scheduleDeletion };
}

function audiobookFetches(conversionId: string): number {
  return app.worker
    .requests()
    .filter(
      (request) =>
        request.method === "GET" &&
        request.path.split("?")[0] === `/api/audiobooks/${conversionId}`,
    ).length;
}

type PositionSave = { synchronizationUnitId: string; offsetMilliseconds: number };

function positionSaves(conversionId: string): PositionSave[] {
  const route = `/api/audiobooks/${conversionId}/position`;
  return app.worker
    .requests()
    .filter((request) => request.method === "PUT" && request.path.split("?")[0] === route)
    .map((request) => {
      expect(request.path).toMatch(new RegExp(`^${route}\\?token=[^&]+$`, "u"));
      expect(request.headers).not.toHaveProperty("authorization");
      expect(request.headers).not.toHaveProperty("origin");
      return parsePositionSave(request.body);
    });
}

function parsePositionSave(body: string | undefined): PositionSave {
  const save: unknown = JSON.parse(body ?? "null");
  if (
    typeof save !== "object" ||
    save === null ||
    !("synchronizationUnitId" in save) ||
    typeof save.synchronizationUnitId !== "string" ||
    !("offsetMilliseconds" in save) ||
    typeof save.offsetMilliseconds !== "number"
  ) {
    throw new Error(`The Worker received an invalid listening-position save: ${body}`);
  }
  return {
    synchronizationUnitId: save.synchronizationUnitId,
    offsetMilliseconds: save.offsetMilliseconds,
  };
}

async function waitForSaveAfter(conversionId: string, saveCount: number): Promise<PositionSave> {
  await expect
    .poll(() => positionSaves(conversionId).length, {
      timeout: SAVE_WAIT_MILLISECONDS,
      message: "The Worker received no listening-position save.",
    })
    .toBeGreaterThan(saveCount);
  await timers.setTimeout(1_500);
  const saves = positionSaves(conversionId);
  return saves[saves.length - 1]!;
}

async function readUnitIds(webView: WebdriverIO.Browser): Promise<string[]> {
  return webView.execute(() => [
    ...new Set(
      Array.from(
        document.querySelectorAll("[data-synchronization-unit]"),
        (element) => element.getAttribute("data-synchronization-unit") ?? "",
      ),
    ),
  ]);
}

function compareSaves(unitIds: readonly string[], left: PositionSave, right: PositionSave) {
  const unitOrder =
    unitIds.indexOf(left.synchronizationUnitId) - unitIds.indexOf(right.synchronizationUnitId);
  expect(unitIds).toContain(left.synchronizationUnitId);
  expect(unitIds).toContain(right.synchronizationUnitId);
  return unitOrder === 0 ? left.offsetMilliseconds - right.offsetMilliseconds : unitOrder;
}

async function waitForSessionToEnd(device: AndroidAppDevice, timeoutMilliseconds: number) {
  await expect
    .poll(() => cupMediaPlaybackService(device), {
      timeout: timeoutMilliseconds,
      message: "Cup's media playback service still runs.",
    })
    .toBeUndefined();
  expect(await cupMediaSession(device)).toBeUndefined();
  expect(await device.dumpsys("notification", "--noredact")).not.toContain(`pkg=${APP_PACKAGE} `);
}

async function waitForServiceToLeaveTheForeground(device: AndroidAppDevice) {
  await expect
    .poll(async () => (await cupMediaPlaybackService(device)) ?? "", {
      timeout: (FOREGROUND_GRACE_SECONDS + 20) * 1_000,
      message: "Cup's media playback service did not leave the foreground.",
    })
    .not.toMatch(/\bisForeground=true\b/u);
  expect(await cupMediaPlaybackService(device)).toBeDefined();
}

async function loseConnectionUntilPlaybackFails(
  device: AndroidAppDevice,
  webView: WebdriverIO.Browser,
): Promise<number> {
  const workerPort = Number(new URL(app.apiOrigin).port);
  const cutAt = await readPosition(webView);
  await device.unexposeHostPort(workerPort);
  try {
    await app.worker.restart("long-speech");
    await expect
      .poll(() => readPageText(webView), { timeout: 60_000 })
      .toContain(MEDIA_ERROR_MESSAGE);
    await waitForPlayButton(webView, "Play");
    expect(await cupMediaSession(device)).toMatch(/\bstate=PlaybackState \{state=ERROR\(7\)/u);
    const failedAt = await readPosition(webView);
    expect(failedAt).toBeGreaterThan(cutAt);
    return failedAt;
  } finally {
    await device.exposeHostPort(workerPort);
  }
}

async function expectToPlayOnFrom(
  device: AndroidAppDevice,
  webView: WebdriverIO.Browser,
  position: number,
) {
  await waitForPlayButton(webView, "Pause");
  await waitForCupMediaSession(device, "PLAYING");
  expect(await readPageText(webView)).not.toContain(MEDIA_ERROR_MESSAGE);
  await expect
    .poll(() => readPosition(webView), { timeout: 15_000 })
    .toBeGreaterThan(position + 2_000);
  expect(await readPosition(webView)).toBeLessThan(position + 30_000);
}

async function readPosition(
  webView: WebdriverIO.Browser | Promise<WebdriverIO.Browser>,
): Promise<number> {
  const session = await webView;
  return Number(await session.$(`${PLAYER} input[type="range"]`).getValue());
}

async function readPageText(webView: WebdriverIO.Browser): Promise<string> {
  return webView.execute(() => document.body.textContent);
}

async function readDuration(webView: WebdriverIO.Browser): Promise<number> {
  return Number(await webView.$(`${PLAYER} input[type="range"]`).getAttribute("max"));
}

async function expectPositionNear(webView: WebdriverIO.Browser, positionMilliseconds: number) {
  await expect
    .poll(async () => Math.abs((await readPosition(webView)) - positionMilliseconds), {
      timeout: 10_000,
    })
    .toBeLessThan(POSITION_TOLERANCE_MILLISECONDS);
}

function parseProgress(progress: string): [positionSeconds: number, durationSeconds: number] {
  const match = /^(?:(\d+) minutes? )?(\d+) seconds? of (?:(\d+) minutes? )?(\d+) seconds?$/u.exec(
    progress,
  );
  if (!match) {
    throw new Error(`Unexpected media controls progress: ${progress}`);
  }
  const [, positionMinutes, positionSeconds, durationMinutes, durationSeconds] = match;
  return [
    Number(positionMinutes ?? 0) * 60 + Number(positionSeconds),
    Number(durationMinutes ?? 0) * 60 + Number(durationSeconds),
  ];
}

async function recordPlayButtonLabels(webView: WebdriverIO.Browser) {
  await webView.execute((player) => {
    const labels: string[] = [];
    const record = () => {
      const label = document
        .querySelector(`${player} button:is([aria-label="Play"], [aria-label="Pause"])`)
        ?.getAttribute("aria-label");
      if (label && labels.at(-1) !== label) {
        labels.push(label);
        document.documentElement.dataset["cupPlayButtonLabels"] = labels.join(" ");
      }
    };
    record();
    const footer = document.querySelector(player);
    if (!footer) {
      throw new Error("The player is not on the page.");
    }
    new MutationObserver(record).observe(footer, {
      subtree: true,
      childList: true,
      attributes: true,
      attributeFilter: ["aria-label"],
    });
  }, PLAYER);
}

async function readPlayButtonLabels(webView: WebdriverIO.Browser): Promise<string[]> {
  const labels = await webView.execute(
    () => document.documentElement.dataset["cupPlayButtonLabels"] ?? "",
  );
  return labels.split(" ").filter((label) => label !== "");
}

async function waitForPlayButton(webView: WebdriverIO.Browser, label: "Play" | "Pause") {
  await webView
    .$(`${PLAYER} button[aria-label="${label}"]`)
    .waitForExist({ timeout: 15_000, timeoutMsg: `The player's button did not turn to ${label}.` });
}

async function cupMediaSession(device: AndroidAppDevice): Promise<string | undefined> {
  const sessions = (await device.dumpsys("media_session")).split(/\n(?= {4}\S)/u);
  return sessions.find((session) => session.includes(`package=${APP_PACKAGE}\n`));
}

async function waitForCupMediaSession(
  device: AndroidAppDevice,
  state: "PLAYING" | "PAUSED",
): Promise<string> {
  let entry: string | undefined;
  await expect
    .poll(
      async () => {
        entry = await cupMediaSession(device);
        return entry?.match(/\bstate=PlaybackState \{state=([A-Z]+)/u)?.[1];
      },
      { timeout: 15_000, message: `Cup's media session is not ${state}.` },
    )
    .toBe(state);
  return entry ?? "";
}

async function cupMediaPlaybackService(device: AndroidAppDevice): Promise<string | undefined> {
  const services = await device.dumpsys("activity", "services", APP_PACKAGE);
  return services
    .split(/\n(?= {2}\* )/u)
    .find(
      (entry) =>
        entry.includes(`ServiceRecord{`) && entry.includes(`${APP_PACKAGE}/.MediaPlaybackService`),
    );
}

async function cupMediaNotification(device: AndroidAppDevice): Promise<string> {
  const notifications = await device.dumpsys("notification", "--noredact");
  const records = notifications.split(/\n(?= {4}NotificationRecord\()/u);
  const record = records.find((entry) => entry.includes(`pkg=${APP_PACKAGE} `));
  if (record === undefined) {
    throw new Error(`Cup has no notification:\n${notifications}`);
  }
  return record;
}

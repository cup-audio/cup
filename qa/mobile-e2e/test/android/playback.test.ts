import timers from "node:timers/promises";
import { expect, test } from "vitest";

import {
  asAndroidAppDevice,
  type AndroidAppDevice,
  type AndroidLaunchArguments,
} from "#src/android/android-app-device.ts";
import { useMobileApp } from "#src/fixtures.ts";
import { signInFromLandingPage, waitForLandingPage, waitForRecents } from "#src/journeys.ts";

/**
 * Native playback in the Android app: the plugin's ExoPlayer plays the narration track in a
 * `mediaPlayback` foreground service, the system's media controls act on it without the page, and
 * the page's player follows the state the plugin reports. Each test signs in, which converts the
 * test Worker's fixture into a new audiobook, and checks what Android sees with `adb`. Loopback is
 * exempt from Android's background network cut, so the locked listen shows the unfrozen process
 * that keeps network access, not the network access itself.
 */
const app = useMobileApp();

const APP_PACKAGE = "audio.cup.app";
const PLAYER = 'footer[aria-label="Player"]';
const SKIP_MILLISECONDS = 15_000;
/** How often the plugin saves the listening position while it plays, as the web player does. */
const SAVE_INTERVAL_MILLISECONDS = 5_000;
/** How far ExoPlayer's position may move after a seek in the MP3 track, a few frames of 26 ms. */
const MP3_SEEK_TOLERANCE_MILLISECONDS = 100;
/** How far the page's position, which follows ExoPlayer's reports, may lag behind or run ahead. */
const POSITION_TOLERANCE_MILLISECONDS = 2_500;
const LOCKED_LISTEN_MILLISECONDS = 120_000;
/** How often the locked listen checks Cup's process and service. */
const LOCKED_CHECK_INTERVAL_MILLISECONDS = 20_000;
/**
 * The test Worker's shortened signed URL lifetime, long enough for the time between the page's last
 * fetch of the audiobook and Play.
 */
const SHORT_URL_LIFETIME_SECONDS = 30;
/** Twice the narration track's 128 kbit/s, so ExoPlayer keeps loading while it plays. */
const TRACK_BYTES_PER_SECOND = 32_000;
/** The page's message for a failed load. */
const MEDIA_ERROR_MESSAGE = "Audio could not be played. Press Play to try again.";
/** Media3's shortened foreground grace after a pause, instead of 10 minutes. */
const FOREGROUND_GRACE_SECONDS = 10;

test("the first Play starts a foreground media session that shows the audiobook and its position", async () => {
  const device = asAndroidAppDevice(app.device);
  const { webView, title, durationMilliseconds, conversionId } = await openNewAudiobook(device);

  // Skipping before the first Play loads the audiobook into the plugin, which prepares nothing but
  // saves the position.
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
  // The notification carries the cover image, which the session loaded from its signed URL.
  expect(await cupMediaNotification(device)).toMatch(
    /\bandroid\.largeIcon=Icon \(Icon\(typ=BITMAP/u,
  );

  // ExoPlayer plays on, also under the emulator's `-no-audio`, from where the skip left it.
  await expect
    .poll(() => readPosition(webView), { timeout: 15_000 })
    .toBeGreaterThan(SKIP_MILLISECONDS + 3_000);

  // System UI reads the whole duration and the position from the session.
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
  // ExoPlayer skips from its own position, so back where it paused, up to the MP3 frame a seek
  // lands on.
  const backSave = await waitForSaveAfter(conversionId, saveCount);
  expect(backSave.synchronizationUnitId).toBe(pauseSave.synchronizationUnitId);
  expect(Math.abs(backSave.offsetMilliseconds - pauseSave.offsetMilliseconds)).toBeLessThan(
    MP3_SEEK_TOLERANCE_MILLISECONDS,
  );

  const durationMilliseconds = await readDuration(webView);
  saveCount = positionSaves(conversionId).length;
  await device.dragMediaControlsSeekBar(0.75);
  webView = await device.webView();
  // A drag lands only roughly where it aims: System UI's bar has margins.
  await expect
    .poll(() => readPosition(webView), { timeout: 10_000 })
    .toBeGreaterThan(durationMilliseconds * 0.5);
  expect(
    compareSaves(unitIds, await waitForSaveAfter(conversionId, saveCount), pauseSave),
  ).toBeGreaterThan(0);
  // None of the controls started playback.
  await waitForPlayButton(webView, "Play");
});

test(
  "a listen with the screen off and Cup in the background keeps playing and saving in an unfrozen process",
  { timeout: LOCKED_LISTEN_MILLISECONDS + 240_000 },
  async () => {
    const device = asAndroidAppDevice(app.device);
    // A track of several minutes, so it plays through the whole locked listen.
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
    const savesBefore = positionSaves(conversionId).length;
    const lockedAt = performance.now();
    for (
      let elapsed = 0;
      elapsed < LOCKED_LISTEN_MILLISECONDS;
      elapsed += LOCKED_CHECK_INTERVAL_MILLISECONDS
    ) {
      await timers.setTimeout(LOCKED_CHECK_INTERVAL_MILLISECONDS);
      // The foreground service keeps Android's cached apps freezer away from Cup.
      expect(await device.isFrozen()).toBe(false);
      expect(await cupMediaPlaybackService(device)).toMatch(/\bisForeground=true\b/u);
    }
    expect(await cupMediaSession(device)).toMatch(/\bstate=PlaybackState \{state=PLAYING\(3\)/u);
    // The plugin saves at the save interval while the page is suspended; it checks twice a second
    // whether a save is due, so the saves come every 5 to 5.5 s.
    const lockedSaves = positionSaves(conversionId).length - savesBefore;
    const lockedMilliseconds = performance.now() - lockedAt;
    expect(lockedSaves).toBeGreaterThanOrEqual(
      Math.floor(lockedMilliseconds / (SAVE_INTERVAL_MILLISECONDS + 500)) - 1,
    );
    expect(lockedSaves).toBeLessThanOrEqual(
      Math.ceil(lockedMilliseconds / SAVE_INTERVAL_MILLISECONDS) + 1,
    );

    await device.turnScreenOnAndUnlock();
    await device.bringToForeground();
    webView = await device.webView();
    // Becoming visible, the page asks the plugin for ExoPlayer's position.
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

  // With speech, ExoPlayer pauses for a duck request instead of lowering its volume.
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
  // Only the server's URLs expire early; the plugin keeps its 24 hours, so the refusal ends it.
  await app.worker.restart("long-speech", { signedUrlLifetimeSeconds: SHORT_URL_LIFETIME_SECONDS });
  const opened = await openNewAudiobook(device);
  const { conversionId } = opened;
  let { webView } = opened;
  await webView.$(`${PLAYER} button[aria-label="Play"]`).click();
  await waitForCupMediaSession(device, "PLAYING");

  await timers.setTimeout((SHORT_URL_LIFETIME_SECONDS + 5) * 1_000);
  // A seek past the buffer requests the track again, with the expired URL.
  await webView.$('button[aria-label="Play segment 4"]').click();
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

  // The media session prepares the failed player itself, without the page.
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
  // Without an activity or a page, the plugin saves on.
  await expect
    .poll(() => positionSaves(conversionId).length, {
      timeout: 3 * SAVE_INTERVAL_MILLISECONDS,
      message: "The plugin saved nothing after the swipe.",
    })
    .toBeGreaterThanOrEqual(savesBeforeSwipe + 2);
  expect(await cupMediaSession(device)).toMatch(/\bstate=PlaybackState \{state=PLAYING\(3\)/u);
  expect(await cupMediaPlaybackService(device)).toMatch(/\bisForeground=true\b/u);

  // A new activity and page in the process the service kept, which asks the plugin what plays.
  await device.reopen();
  webView = await device.webView();
  // Recents' mini player or the audiobook's sheet, whichever page Cup opens on.
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

test("signing out saves the position one last time through the position URL and ends the session", async () => {
  const device = asAndroidAppDevice(app.device);
  await app.worker.restart("long-speech");
  const opened = await openNewAudiobook(device);
  const { conversionId } = opened;
  let { webView } = opened;
  await webView.$(`${PLAYER} button[aria-label="Play"]`).click();
  await waitForCupMediaSession(device, "PLAYING");

  // Scheduling the account's deletion is how a listener signs out; it signs in afresh first.
  await webView.$('a[aria-label="Back"]').click();
  await waitForRecents(webView, 1);
  await webView.$('a[aria-label="Account"]').click();
  await webView.$("button=Delete account…").click();
  await device.continueGoogleSignIn();
  webView = await device.webView();
  const scheduleDeletion = webView.$("button=Schedule deletion");
  await scheduleDeletion.waitForEnabled({ timeout: 30_000 });
  // The player paused on the way here (on the 2026-11-16 run, about 2 s after Play), but its
  // session runs on until the sign-out closes it.
  expect(await cupMediaPlaybackService(device)).toBeDefined();
  const savesBeforeSignOut = positionSaves(conversionId).length;
  await scheduleDeletion.click();
  await waitForLandingPage(webView);

  await waitForSessionToEnd(device, 15_000);
  // The listener's session is gone by now; the position URL authorizes the save on its own. The
  // Worker refuses it, since a scheduled deletion blocks the account, but the save was sent.
  await waitForSaveAfter(conversionId, savesBeforeSignOut);
});

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

    // Media3 brings the service back to the foreground before ExoPlayer plays.
    await device.tapMediaControl("Play");
    await waitForCupMediaSession(device, "PLAYING");
    expect(await cupMediaPlaybackService(device)).toMatch(/\bisForeground=true\b/u);

    // During a call ExoPlayer still wants to play, so the service stays in the foreground.
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

    // The page keeps the audiobook where it stopped, and Play loads it into a new session.
    await device.bringToForeground();
    webView = await device.webView();
    await waitForPlayButton(webView, "Play");
    await expectPositionNear(webView, pausedAt);
    await webView.$(`${PLAYER} button[aria-label="Play"]`).click();
    await waitForPlayButton(webView, "Pause");
    await waitForCupMediaSession(device, "PLAYING");
  },
);

/** Signs in, which opens the new audiobook's page, and waits until it can play. */
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

/** How often the Worker answered a request for the audiobook, which renews its signed URLs. */
function audiobookFetches(conversionId: string): number {
  return app.worker
    .requests()
    .filter(
      (request) => request.method === "GET" && request.path === `/api/audiobooks/${conversionId}`,
    ).length;
}

/** A listening position as the position route stores it. */
type PositionSave = { synchronizationUnitId: string; offsetMilliseconds: number };

/**
 * The listening positions the Worker received for the audiobook, oldest first. Every one came
 * through the signed position URL, without a bearer token: the page saves nothing on Android.
 */
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

/**
 * Waits until the Worker received a save after the first `saveCount`, then for the saves to settle,
 * and returns the last one.
 */
async function waitForSaveAfter(conversionId: string, saveCount: number): Promise<PositionSave> {
  await expect
    .poll(() => positionSaves(conversionId).length, {
      timeout: 10_000,
      message: "The Worker received no listening-position save.",
    })
    .toBeGreaterThan(saveCount);
  // A save during playback may have been on its way before the one the action sent.
  await timers.setTimeout(1_500);
  const saves = positionSaves(conversionId);
  return saves[saves.length - 1]!;
}

/** The audiobook's synchronization units in document order, from its segment controls. */
async function readUnitIds(webView: WebdriverIO.Browser): Promise<string[]> {
  return webView.execute(() =>
    Array.from(
      document.querySelectorAll("button[data-segment-control]"),
      (button) => button.parentElement?.id ?? "",
    ),
  );
}

/** Orders two saves by where they are in the audiobook: negative, zero or positive. */
function compareSaves(unitIds: readonly string[], left: PositionSave, right: PositionSave) {
  const unitOrder =
    unitIds.indexOf(left.synchronizationUnitId) - unitIds.indexOf(right.synchronizationUnitId);
  expect(unitIds).toContain(left.synchronizationUnitId);
  expect(unitIds).toContain(right.synchronizationUnitId);
  return unitOrder === 0 ? left.offsetMilliseconds - right.offsetMilliseconds : unitOrder;
}

/** Waits until Cup's service, its notification and its media session are gone. */
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

/** Waits until the service has left the foreground, after the shortened grace. */
async function waitForServiceToLeaveTheForeground(device: AndroidAppDevice) {
  await expect
    .poll(async () => (await cupMediaPlaybackService(device)) ?? "", {
      timeout: (FOREGROUND_GRACE_SECONDS + 20) * 1_000,
      message: "Cup's media playback service did not leave the foreground.",
    })
    .not.toMatch(/\bisForeground=true\b/u);
  expect(await cupMediaPlaybackService(device)).toBeDefined();
}

/**
 * Cuts the connection to the test Worker while the player plays, waits until the page reports the
 * failure, and returns the position where it stopped; the Worker is reachable again afterwards.
 */
async function loseConnectionUntilPlaybackFails(
  device: AndroidAppDevice,
  webView: WebdriverIO.Browser,
): Promise<number> {
  const workerPort = Number(new URL(app.apiOrigin).port);
  const cutAt = await readPosition(webView);
  await device.unexposeHostPort(workerPort);
  try {
    // `adb reverse --remove` refuses new connections only; restarting the Worker ends the ones
    // ExoPlayer holds, the track's response and idle keep-alive connections alike.
    await app.worker.restart("long-speech");
    await expect
      .poll(() => readPageText(webView), { timeout: 60_000 })
      .toContain(MEDIA_ERROR_MESSAGE);
    await waitForPlayButton(webView, "Play");
    // Media3 reports the failed player to the system as an error, whose notification offers Play.
    expect(await cupMediaSession(device)).toMatch(/\bstate=PlaybackState \{state=ERROR\(7\)/u);
    // The cut response is a failed load, not the end of the track, which would start over.
    const failedAt = await readPosition(webView);
    expect(failedAt).toBeGreaterThan(cutAt);
    return failedAt;
  } finally {
    await device.exposeHostPort(workerPort);
  }
}

/** Waits until the player plays on from `position`, with the error gone. */
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

/** The position the player sheet's scrubber shows. */
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

/** System UI describes its progress bar as, for example, `9 seconds of 19 seconds`. */
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

/** Waits until the player's button reads `label`, as the plugin reports playing or not. */
async function waitForPlayButton(webView: WebdriverIO.Browser, label: "Play" | "Pause") {
  await webView
    .$(`${PLAYER} button[aria-label="${label}"]`)
    .waitForExist({ timeout: 15_000, timeoutMsg: `The player's button did not turn to ${label}.` });
}

/** Cup's entry in `dumpsys media_session`, or `undefined` while Cup has none. */
async function cupMediaSession(device: AndroidAppDevice): Promise<string | undefined> {
  const sessions = (await device.dumpsys("media_session")).split(/\n(?= {4}\S)/u);
  return sessions.find((session) => session.includes(`package=${APP_PACKAGE}\n`));
}

/** Waits until Cup's media session is in `state`, and returns its entry. */
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

/** The record of Cup's media playback service in `dumpsys activity services`, while it runs. */
async function cupMediaPlaybackService(device: AndroidAppDevice): Promise<string | undefined> {
  const services = await device.dumpsys("activity", "services", APP_PACKAGE);
  return services
    .split(/\n(?= {2}\* )/u)
    .find(
      (entry) =>
        entry.includes(`ServiceRecord{`) && entry.includes(`${APP_PACKAGE}/.MediaPlaybackService`),
    );
}

/** Cup's media notification in `dumpsys notification`, with its extras. */
async function cupMediaNotification(device: AndroidAppDevice): Promise<string> {
  const notifications = await device.dumpsys("notification", "--noredact");
  const records = notifications.split(/\n(?= {4}NotificationRecord\()/u);
  const record = records.find((entry) => entry.includes(`pkg=${APP_PACKAGE} `));
  if (record === undefined) {
    throw new Error(`Cup has no notification:\n${notifications}`);
  }
  return record;
}

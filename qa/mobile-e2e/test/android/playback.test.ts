import timers from "node:timers/promises";
import { expect, test } from "vitest";

import { asAndroidAppDevice, type AndroidAppDevice } from "#src/android/android-app-device.ts";
import { useMobileApp } from "#src/fixtures.ts";
import { signInFromLandingPage } from "#src/journeys.ts";

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
/** How far the page's position, which follows ExoPlayer's reports, may lag behind or run ahead. */
const POSITION_TOLERANCE_MILLISECONDS = 2_500;
const LOCKED_LISTEN_MILLISECONDS = 120_000;
/** How often the locked listen checks Cup's process and service. */
const LOCKED_CHECK_INTERVAL_MILLISECONDS = 20_000;

test("the first Play starts a foreground media session that shows the audiobook and its position", async () => {
  const device = asAndroidAppDevice(app.device);
  const { webView, title, durationMilliseconds } = await openNewAudiobook(device);

  // Skipping before the first Play loads the audiobook into the plugin, which prepares nothing.
  await webView.$(`${PLAYER} button[aria-label="Forward 15 seconds"]`).click();
  await expect.poll(() => readPosition(webView)).toBe(SKIP_MILLISECONDS);
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

test("media keys and the notification's buttons and seek bar act on the player without the page", async () => {
  const device = asAndroidAppDevice(app.device);
  let { webView } = await openNewAudiobook(device);
  await webView.$(`${PLAYER} button[aria-label="Play"]`).click();
  await waitForCupMediaSession(device, "PLAYING");

  await device.pressMediaKey("KEYCODE_MEDIA_PAUSE");
  await waitForPlayButton(webView, "Play");
  await waitForCupMediaSession(device, "PAUSED");
  await device.pressMediaKey("KEYCODE_MEDIA_PLAY");
  await waitForPlayButton(webView, "Pause");
  await device.pressMediaKey("KEYCODE_MEDIA_PAUSE");
  await waitForPlayButton(webView, "Play");

  const pausedAt = await readPosition(webView);
  await device.tapMediaControl("Forward 15 seconds");
  webView = await device.webView();
  await expectPositionNear(webView, pausedAt + SKIP_MILLISECONDS);

  await device.tapMediaControl("Back 15 seconds");
  webView = await device.webView();
  await expectPositionNear(webView, pausedAt);

  const durationMilliseconds = await readDuration(webView);
  await device.dragMediaControlsSeekBar(0.75);
  webView = await device.webView();
  // A drag lands only roughly where it aims: System UI's bar has margins.
  await expect
    .poll(() => readPosition(webView), { timeout: 10_000 })
    .toBeGreaterThan(durationMilliseconds * 0.5);
  // None of the controls started playback.
  await waitForPlayButton(webView, "Play");
});

test(
  "a listen with the screen off and Cup in the background keeps playing in an unfrozen process",
  { timeout: LOCKED_LISTEN_MILLISECONDS + 240_000 },
  async () => {
    const device = asAndroidAppDevice(app.device);
    // A track of several minutes, so it plays through the whole locked listen.
    await app.worker.restart("long-speech");
    let { webView } = await openNewAudiobook(device);
    expect(await readDuration(webView)).toBeGreaterThan(LOCKED_LISTEN_MILLISECONDS + 30_000);
    await webView.$(`${PLAYER} button[aria-label="Play"]`).click();
    await waitForPlayButton(webView, "Pause");
    await waitForCupMediaSession(device, "PLAYING");
    const startPosition = await readPosition(webView);

    await device.background();
    await device.turnScreenOff();
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

/** Signs in, which opens the new audiobook's page, and waits until it can play. */
async function openNewAudiobook(device: AndroidAppDevice) {
  await device.launch({ apiOrigin: app.apiOrigin });
  const webView = await device.webView();
  await signInFromLandingPage(device, webView);
  await webView.$(`${PLAYER} button[aria-label="Play"]`).waitForEnabled({ timeout: 120_000 });
  const title = await webView.execute(() => document.querySelector("h1")?.textContent ?? "");
  const durationMilliseconds = await readDuration(webView);
  expect(title).not.toBe("");
  expect(durationMilliseconds).toBeGreaterThan(5_000);
  return { webView, title, durationMilliseconds };
}

/** The position the player sheet's scrubber shows. */
async function readPosition(
  webView: WebdriverIO.Browser | Promise<WebdriverIO.Browser>,
): Promise<number> {
  const session = await webView;
  return Number(await session.$(`${PLAYER} input[type="range"]`).getValue());
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

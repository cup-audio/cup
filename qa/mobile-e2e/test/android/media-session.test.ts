import { expect, test } from "vitest";

import { asAndroidAppDevice, type AndroidAppDevice } from "#src/android/android-app-device.ts";
import { useMobileApp } from "#src/fixtures.ts";
import { signInFromLandingPage } from "#src/journeys.ts";

/**
 * The media session plugin: playing an audiobook shows it in a Media3 session held by a
 * `mediaPlayback` foreground service, and the session's media keys reach the page, which pauses,
 * saves the position and plays again. Loopback is exempt from Android's background network cut, so
 * this does not show listening with the screen locked.
 */
const app = useMobileApp();

const APP_PACKAGE = "audio.cup.app";

test("playing an audiobook shows it in a foreground media session, whose media keys pause and play it", async () => {
  const device = asAndroidAppDevice(app.device);
  await device.launch({ apiOrigin: app.apiOrigin });
  let webView = await device.webView();
  await signInFromLandingPage(device, webView);
  const play = webView.$('footer[aria-label="Player"] button[aria-label="Play"]');
  await play.waitForEnabled({ timeout: 120_000 });
  const title = await webView.execute(() => document.querySelector("h1")?.textContent ?? "");
  const durationMilliseconds = Number(
    await webView.$('footer[aria-label="Player"] input[type="range"]').getAttribute("max"),
  );
  expect(title).not.toBe("");
  expect(durationMilliseconds).toBeGreaterThan(5_000);

  const startSaves = positionSaves().length;
  await play.click();
  await waitForPlayButton(webView, "Pause");
  // Playback saves the position at once and then every 5 seconds, so the pause below comes before
  // the next save that playback alone would send.
  await expect.poll(() => positionSaves().length, { timeout: 10_000 }).toBeGreaterThan(startSaves);

  const session = await cupMediaSession(device);
  expect(session).toContain(`description=${title}, `);
  expect(session).toMatch(/\bstate=PlaybackState \{state=PLAYING\(3\)/u);
  const service = await cupMediaPlaybackService(device);
  expect(service).toMatch(/\bisForeground=true\b.*\btypes=0x00000002\b/u);

  const savesBeforePause = positionSaves().length;
  await device.pressMediaKey("KEYCODE_MEDIA_PAUSE");
  await waitForPlayButton(webView, "Play");
  await expect
    .poll(() => positionSaves().length, { timeout: 10_000 })
    .toBeGreaterThan(savesBeforePause);
  expect(await cupMediaSession(device)).toMatch(/\bstate=PlaybackState \{state=PAUSED\(2\)/u);

  // System UI reads the whole duration from the session, which `dumpsys` does not print.
  const progress = await device.readMediaControlsProgress();
  webView = await device.webView();
  const shownDurationSeconds = Number(/ of (\d+) seconds?$/u.exec(progress)?.[1]);
  expect(Math.abs(shownDurationSeconds * 1_000 - durationMilliseconds)).toBeLessThan(1_000);

  await device.pressMediaKey("KEYCODE_MEDIA_PLAY");
  await waitForPlayButton(webView, "Pause");
});

/** The position saves the test Worker received, oldest first. */
function positionSaves() {
  return app.worker
    .requests()
    .filter(
      ({ method, path }) => method === "PUT" && /^\/api\/audiobooks\/[^/]+\/position$/u.test(path),
    );
}

/** Waits until the player sheet's play button reads `label`, as the page's `<audio>` plays or not. */
async function waitForPlayButton(webView: WebdriverIO.Browser, label: "Play" | "Pause") {
  await webView
    .$(`footer[aria-label="Player"] button[aria-label="${label}"]`)
    .waitForExist({ timeout: 10_000, timeoutMsg: `The player's button did not turn to ${label}.` });
}

/** Cup's entry in `dumpsys media_session`, once Cup has one. */
async function cupMediaSession(device: AndroidAppDevice): Promise<string> {
  let entry = "";
  await expect
    .poll(
      async () => {
        const sessions = (await device.dumpsys("media_session")).split(/\n(?= {4}\S)/u);
        entry = sessions.find((session) => session.includes(`package=${APP_PACKAGE}\n`)) ?? "";
        return entry;
      },
      { timeout: 10_000, message: "Cup has no media session." },
    )
    .not.toBe("");
  return entry;
}

/** The record of Cup's media session service in `dumpsys activity services`. */
async function cupMediaPlaybackService(device: AndroidAppDevice): Promise<string> {
  const services = await device.dumpsys("activity", "services", APP_PACKAGE);
  const record = services
    .split(/\n(?= {2}\* )/u)
    .find(
      (entry) =>
        entry.includes(`ServiceRecord{`) && entry.includes(`${APP_PACKAGE}/.MediaPlaybackService`),
    );
  if (record === undefined) {
    throw new Error(`Cup's media session service does not run:\n${services}`);
  }
  return record;
}

/* oxlint-disable node/no-process-env -- The script passes the environment on to Gradle and reads the adb device selection. */
import childProcess from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import timers from "node:timers/promises";

import { DEFAULT_SDK_ROOT, resolveAndroidSdkRoot } from "#scripts/android-sdk.mts";
import { fail, MOBILE_APP_ROOT, runCaptured, runVisible } from "#scripts/script-process.mts";

const APP_ID = "audio.cup.app";
const MAIN_ACTIVITY = `${APP_ID}/.MainActivity`;
const ANDROID_PROJECT = path.join(MOBILE_APP_ROOT, "android");
const SECONDS_TO_SURVIVE_LAUNCH = 5;

const sdkRoot = resolveAndroidSdkRoot();
const adb = path.join(sdkRoot, "platform-tools", "adb");
if (!fs.existsSync(adb)) {
  fail(
    `adb is missing at ${adb}. Install Android Studio with "Android SDK Platform-Tools", or set ANDROID_HOME to an existing SDK (Android Studio's default is ${DEFAULT_SDK_ROOT}).`,
  );
}

const serial = selectDevice();
console.log(`Deploying to ${serial}.`);

const environment: NodeJS.ProcessEnv = {
  ...process.env,
  ANDROID_HOME: sdkRoot,
  ANDROID_SERIAL: serial,
};

runVisible("pnpm", ["exec", "turbo", "run", "turbo:build"], {
  cwd: MOBILE_APP_ROOT,
  env: environment,
});
runVisible("pnpm", ["exec", "cap", "sync", "android"], { cwd: MOBILE_APP_ROOT, env: environment });
runVisible("./gradlew", ["installDebug", "--console=plain"], {
  cwd: ANDROID_PROJECT,
  env: environment,
});

const launchOutput = runCaptured(adb, [
  "-s",
  serial,
  "shell",
  "am",
  "start",
  "-W",
  "-n",
  MAIN_ACTIVITY,
]);
if (!launchOutput.includes("Status: ok")) {
  fail(`Launching ${MAIN_ACTIVITY} failed:\n${launchOutput}`);
}

await timers.setTimeout(SECONDS_TO_SURVIVE_LAUNCH * 1000);
const pid = childProcess.spawnSync(adb, ["-s", serial, "shell", "pidof", APP_ID], {
  encoding: "utf8",
});
if (pid.status !== 0) {
  fail(
    `${APP_ID} stopped within ${SECONDS_TO_SURVIVE_LAUNCH} seconds of launching. Read the crash with \`adb -s ${serial} logcat -b crash -d\`.`,
  );
}
console.log(
  `${APP_ID} is running on ${serial}. Check that its UI renders, for example with \`adb -s ${serial} exec-out screencap -p > screen.png\`.`,
);

function selectDevice(): string {
  const connected = runCaptured(adb, ["devices"])
    .split("\n")
    .slice(1)
    .flatMap((line) => {
      const [serialOfLine, state] = line.trim().split(/\s+/);
      return serialOfLine !== undefined && state === "device" ? [serialOfLine] : [];
    });

  const requested = process.env["ANDROID_SERIAL"];
  if (requested !== undefined) {
    if (!connected.includes(requested)) {
      fail(
        `ANDROID_SERIAL is ${requested}, which is not a connected device. Connected: ${connected.join(", ") || "none"}.`,
      );
    }
    return requested;
  }

  const [only, ...others] = connected;
  if (only === undefined) {
    fail(
      "No Android device is connected. Connect a device with USB debugging enabled or start an emulator, and confirm it is listed by `adb devices`.",
    );
  }
  if (others.length > 0) {
    fail(
      `Several Android devices are connected: ${connected.join(", ")}. Set ANDROID_SERIAL to the one to deploy to.`,
    );
  }
  return only;
}

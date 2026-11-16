/*
 * Runs the Android app's JVM unit tests (`android/app/src/test`), which cover the plugin's plain
 * Java logic, with Gradle's `testDebugUnitTest`. `.mts` because this package is CommonJS for
 * `capacitor.config.ts`.
 */
import childProcess from "node:child_process";
import fs from "node:fs";
import path from "node:path";

import { requireJvmToolchain } from "#scripts/jvm-toolchain.mts";

const MOBILE_APP_ROOT = path.resolve(import.meta.dirname, "..");
const ANDROID_PROJECT = path.join(MOBILE_APP_ROOT, "android");

// Gradle reads the SDK from ANDROID_HOME, so no `local.properties` is needed.
const environment: NodeJS.ProcessEnv = { ...process.env, ANDROID_HOME: requireJvmToolchain() };

// Writes the Gradle projects of Capacitor's plugins, which the app's build includes, without the web
// bundle that `cap sync` would also copy. It writes the plugin list into the assets folder, which
// only that copy would otherwise create.
fs.mkdirSync(path.join(ANDROID_PROJECT, "app", "src", "main", "assets"), { recursive: true });
runVisible("pnpm", ["exec", "cap", "update", "android"], MOBILE_APP_ROOT, environment);
runVisible("./gradlew", ["testDebugUnitTest", "--console=plain"], ANDROID_PROJECT, environment);

function runVisible(
  command: string,
  args: readonly string[],
  cwd: string,
  env: NodeJS.ProcessEnv,
): void {
  const result = childProcess.spawnSync(command, args, { cwd, env, stdio: "inherit" });
  if (result.status !== 0) {
    console.error(`\`${[command, ...args].join(" ")}\` exited with ${String(result.status)}.`);
    process.exit(1);
  }
}

import childProcess from "node:child_process";
import fs from "node:fs";
import path from "node:path";

import { requireJvmToolchain } from "#scripts/jvm-toolchain.mts";

const MOBILE_APP_ROOT = path.resolve(import.meta.dirname, "..");
const ANDROID_PROJECT = path.join(MOBILE_APP_ROOT, "android");

const environment: NodeJS.ProcessEnv = { ...process.env, ANDROID_HOME: requireJvmToolchain() };

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

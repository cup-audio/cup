/* oxlint-disable node/no-process-env -- The check reads the host's Java location. */
/*
 * Checks the toolchain the JVM unit tests need, the Android SDK and Java 21, and prints every
 * problem with its fix. The review gate runs it as a prerequisite; `test-jvm.mts` runs it first.
 * `.mts` because this package is CommonJS for `capacitor.config.ts`.
 */
import childProcess from "node:child_process";
import fs from "node:fs";
import path from "node:path";

import { DEFAULT_SDK_ROOT, resolveAndroidSdkRoot } from "#scripts/android-sdk.mts";

const ANDROID_STUDIO_JAVA_HOME = "/Applications/Android Studio.app/Contents/jbr/Contents/Home";

/** Returns the Android SDK root Gradle gets as `ANDROID_HOME`, or exits with every problem. */
export function requireJvmToolchain(): string {
  const sdkRoot = resolveAndroidSdkRoot();
  const problems: string[] = [];
  if (!fs.existsSync(path.join(sdkRoot, "platforms"))) {
    problems.push(
      `The Android SDK is missing at ${sdkRoot}. Install Android Studio, or set ANDROID_HOME to an existing SDK (Android Studio's default is ${DEFAULT_SDK_ROOT}).`,
    );
  }
  const javaProblem = findJava21Problem();
  if (javaProblem !== undefined) {
    problems.push(
      `${javaProblem} Gradle needs Java 21: set JAVA_HOME to a Java 21 installation, such as Android Studio's ${ANDROID_STUDIO_JAVA_HOME}.`,
    );
  }
  if (problems.length > 0) {
    console.error(
      `The Android app's JVM unit tests cannot run:\n${problems.map((problem) => `- ${problem}`).join("\n")}`,
    );
    process.exit(1);
  }
  return sdkRoot;
}

/** Gradle runs with `JAVA_HOME`'s Java, or with the one on `PATH`. */
function findJava21Problem(): string | undefined {
  const javaHome = process.env["JAVA_HOME"];
  const java = javaHome === undefined ? "java" : path.join(javaHome, "bin", "java");
  // `java -version` writes to stderr.
  const result = childProcess.spawnSync(java, ["-version"], { encoding: "utf8" });
  if (result.status !== 0) {
    return javaHome === undefined
      ? "No Java runtime is on PATH and JAVA_HOME is not set."
      : `JAVA_HOME points to ${javaHome}, which has no working bin/java.`;
  }
  const major = /version "(\d+)/.exec(result.stderr)?.[1];
  return major === "21" ? undefined : `${java} is Java ${major ?? "of an unknown version"}.`;
}

if (import.meta.main) {
  requireJvmToolchain();
}

/* oxlint-disable node/no-process-env -- The preflight reads the host's Android SDK and Java locations. */
import fs from "node:fs";
import path from "node:path";

import { DEFAULT_SDK_ROOT, resolveAndroidSdkRoot } from "@cup/mobile-app/android-sdk";

import { run } from "#src/host.ts";

export type AndroidHost = {
  readonly sdkRoot: string;
  readonly adb: string;
  readonly emulator: string;
  readonly avdManager: string;
  readonly javaHome: string | undefined;
};

export const SYSTEM_IMAGE_PACKAGE = "system-images;android-36;google_apis;arm64-v8a";

const ANDROID_STUDIO_JAVA_HOME = "/Applications/Android Studio.app/Contents/jbr/Contents/Home";

export async function checkAndroidHost(): Promise<AndroidHost> {
  const problems: string[] = [];

  const sdkRoot = resolveAndroidSdkRoot();
  const adb = path.join(sdkRoot, "platform-tools", "adb");
  const emulator = path.join(sdkRoot, "emulator", "emulator");
  const avdManager = path.join(sdkRoot, "cmdline-tools", "latest", "bin", "avdmanager");
  const systemImage = path.join(sdkRoot, ...SYSTEM_IMAGE_PACKAGE.split(";"));

  if (!fs.existsSync(sdkRoot)) {
    problems.push(
      `The Android SDK is missing at ${sdkRoot}. Install Android Studio, or set ANDROID_HOME to an existing SDK (Android Studio's default is ${DEFAULT_SDK_ROOT}).`,
    );
  } else {
    if (!fs.existsSync(adb)) {
      problems.push(
        `adb is missing at ${adb}. Install "Android SDK Platform-Tools" in Android Studio's SDK Manager.`,
      );
    }
    if (!fs.existsSync(emulator)) {
      problems.push(
        `The Android Emulator is missing at ${emulator}. Install "Android Emulator" in Android Studio's SDK Manager.`,
      );
    }
    if (!fs.existsSync(avdManager)) {
      problems.push(
        `avdmanager is missing at ${avdManager}. Install "Android SDK Command-line Tools (latest)" in Android Studio's SDK Manager.`,
      );
    }
    if (!fs.existsSync(systemImage)) {
      const sdkManager = path.join(sdkRoot, "cmdline-tools", "latest", "bin", "sdkmanager");
      problems.push(
        `The system image ${SYSTEM_IMAGE_PACKAGE} is missing. Install it with \`${sdkManager} "${SYSTEM_IMAGE_PACKAGE}"\`.`,
      );
    }
  }

  const javaHome = resolveJavaHome();
  const javaVersionProblem = await checkJava21(javaHome);
  if (javaVersionProblem !== undefined) {
    problems.push(
      `${javaVersionProblem} Gradle needs Java 21: set JAVA_HOME to a Java 21 installation, such as Android Studio's ${ANDROID_STUDIO_JAVA_HOME}.`,
    );
  }

  if (problems.length > 0) {
    throw new Error(
      `The Android run of the mobile E2E suite cannot start:\n${problems.map((problem) => `- ${problem}`).join("\n")}\nSee qa/mobile-e2e/README.md for the prerequisites.`,
    );
  }
  return { sdkRoot, adb, emulator, avdManager, javaHome };
}

export function resolveJavaHome(): string | undefined {
  return process.env["JAVA_HOME"];
}

export function javaExecutable(javaHome: string | undefined): string {
  return javaHome === undefined ? "java" : path.join(javaHome, "bin", "java");
}

async function checkJava21(javaHome: string | undefined): Promise<string | undefined> {
  const java = javaExecutable(javaHome);
  let output: string;
  try {
    output = (await run(java, ["-version"])).stderr;
  } catch {
    return javaHome === undefined
      ? "No Java runtime is on PATH and JAVA_HOME is not set."
      : `JAVA_HOME points to ${javaHome}, which has no working bin/java.`;
  }
  const major = /version "(\d+)/.exec(output)?.[1];
  if (major !== "21") {
    return `${java} is Java ${major ?? "of an unknown version"}.`;
  }
  return undefined;
}

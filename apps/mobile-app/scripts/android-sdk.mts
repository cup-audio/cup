/* oxlint-disable node/no-process-env -- The lookup reads the host's Android SDK location. */
/*
 * Where this package's scripts and the mobile E2E suite (`@cup/mobile-app/android-sdk`) find the
 * Android SDK. `.mts` because this package is CommonJS for `capacitor.config.ts`.
 */
import os from "node:os";
import path from "node:path";

/** Android Studio's default SDK location on macOS. */
export const DEFAULT_SDK_ROOT = path.join(os.homedir(), "Library", "Android", "sdk");

/** The SDK to use: `ANDROID_HOME`, then `ANDROID_SDK_ROOT`, then Android Studio's default. */
export function resolveAndroidSdkRoot(): string {
  return process.env["ANDROID_HOME"] ?? process.env["ANDROID_SDK_ROOT"] ?? DEFAULT_SDK_ROOT;
}

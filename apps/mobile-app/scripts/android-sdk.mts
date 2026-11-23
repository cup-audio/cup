/* oxlint-disable node/no-process-env -- The lookup reads the host's Android SDK location. */
import os from "node:os";
import path from "node:path";

export const DEFAULT_SDK_ROOT = path.join(os.homedir(), "Library", "Android", "sdk");

export function resolveAndroidSdkRoot(): string {
  return process.env["ANDROID_HOME"] ?? process.env["ANDROID_SDK_ROOT"] ?? DEFAULT_SDK_ROOT;
}

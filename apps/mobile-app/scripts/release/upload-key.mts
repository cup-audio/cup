import childProcess from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import type { UploadKeyStore } from "#scripts/release/release-preconditions.mts";
import { MOBILE_APP_ROOT } from "#scripts/script-process.mts";

export const KEYSTORE_PATH = path.join(MOBILE_APP_ROOT, "android", "upload-keystore.jks");
export const KEYCHAIN_SERVICE = "cup-android-upload-key";
export const KEYCHAIN_ACCOUNT = os.userInfo().username;
export const KEYCHAIN_ITEM_DESCRIPTION = `the Keychain generic-password item with service "${KEYCHAIN_SERVICE}" and account "${KEYCHAIN_ACCOUNT}"`;
export const KEY_ALIAS = "upload";
export const PASSWORD_VARIABLE = "CUP_UPLOAD_KEYSTORE_PASSWORD";
export const KEYSTORE_PATH_VARIABLE = "CUP_UPLOAD_KEYSTORE_PATH";

const SECURITY_ITEM_NOT_FOUND = 44;

export const UPLOAD_KEY_STORE: UploadKeyStore = {
  keystorePath: KEYSTORE_PATH,
  keychainItemDescription: KEYCHAIN_ITEM_DESCRIPTION,
  hasKeystore: () => fs.existsSync(KEYSTORE_PATH),
  hasKeychainItem,
};

export function hasKeychainItem(): boolean {
  const result = childProcess.spawnSync(
    "security",
    ["find-generic-password", "-s", KEYCHAIN_SERVICE, "-a", KEYCHAIN_ACCOUNT],
    { encoding: "utf8" },
  );
  if (result.status === 0) {
    return true;
  }
  if (result.status === SECURITY_ITEM_NOT_FOUND) {
    return false;
  }
  throw new Error(
    `\`security find-generic-password\` exited with ${String(result.status)}: ${result.stderr.trim()}`,
  );
}

export function readKeystorePassword(): string {
  const result = childProcess.spawnSync(
    "security",
    ["find-generic-password", "-s", KEYCHAIN_SERVICE, "-a", KEYCHAIN_ACCOUNT, "-w"],
    { encoding: "utf8" },
  );
  const password = result.stdout.trim();
  if (result.status !== 0 || password === "") {
    throw new Error(
      `Reading the password from ${KEYCHAIN_ITEM_DESCRIPTION} failed with exit status ${String(result.status)}:\n${result.stderr}`,
    );
  }
  return password;
}

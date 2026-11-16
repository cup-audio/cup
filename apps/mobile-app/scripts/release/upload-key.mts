/*
 * Where the Android upload key lives: a PKCS12 keystore in the Android project, whose password is a
 * macOS Keychain generic-password item. `android:upload-key:create` writes both, `android:release`
 * reads them. See the README's "Release builds".
 */
import childProcess from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import type { UploadKeyStore } from "#scripts/release/release-preconditions.mts";

const MOBILE_APP_ROOT = path.resolve(import.meta.dirname, "..", "..");

// `tooling/env-setup` copies this file into linked worktrees, and `android/.gitignore` keeps it out of Git.
export const KEYSTORE = path.join(MOBILE_APP_ROOT, "android", "upload-keystore.jks");
export const KEYCHAIN_SERVICE = "cup-android-upload-key";
export const KEYCHAIN_ACCOUNT = os.userInfo().username;
export const KEYCHAIN_ITEM_DESCRIPTION = `the Keychain generic-password item with service "${KEYCHAIN_SERVICE}" and account "${KEYCHAIN_ACCOUNT}"`;
export const KEY_ALIAS = "upload";
/**
 * Hands the password to keytool and Gradle (`android/app/build.gradle`) without a command-line
 * argument.
 */
export const PASSWORD_VARIABLE = "CUP_UPLOAD_KEYSTORE_PASSWORD";
/** Hands the keystore path to Gradle (`android/app/build.gradle`). */
export const KEYSTORE_PATH_VARIABLE = "CUP_UPLOAD_KEYSTORE_PATH";

/** `security find-generic-password` exits with this status when no item matches. */
const SECURITY_ITEM_NOT_FOUND = 44;

export const UPLOAD_KEY_STORE: UploadKeyStore = {
  keystorePath: KEYSTORE,
  keychainItemDescription: KEYCHAIN_ITEM_DESCRIPTION,
  hasKeystore: () => fs.existsSync(KEYSTORE),
  hasKeychainItem,
};

export function hasKeychainItem(): boolean {
  // Without `-w` or `-g`, `security` prints the item's attributes but never its password.
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
    `Looking up ${KEYCHAIN_ITEM_DESCRIPTION} failed with exit status ${String(result.status)}:\n${result.stderr}`,
  );
}

/** Reads the keystore password from the Keychain; macOS may ask to allow access first. */
export function readKeystorePassword(): string {
  const result = childProcess.spawnSync(
    "security",
    ["find-generic-password", "-s", KEYCHAIN_SERVICE, "-a", KEYCHAIN_ACCOUNT, "-w"],
    { encoding: "utf8" },
  );
  // `-w` prints the password and a newline.
  const password = result.stdout.trim();
  if (result.status !== 0 || password === "") {
    throw new Error(
      `Reading the password from ${KEYCHAIN_ITEM_DESCRIPTION} failed with exit status ${String(result.status)}:\n${result.stderr}`,
    );
  }
  return password;
}

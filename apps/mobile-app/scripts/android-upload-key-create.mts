/* oxlint-disable node/no-process-env -- The script finds keytool through JAVA_HOME and hands keytool the password through its environment. */
import childProcess from "node:child_process";
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";

import {
  hasKeychainItem,
  KEY_ALIAS,
  KEYCHAIN_ACCOUNT,
  KEYCHAIN_ITEM_DESCRIPTION,
  KEYCHAIN_SERVICE,
  KEYSTORE_PATH,
  PASSWORD_VARIABLE,
} from "#scripts/release/upload-key.mts";
import { fail, runCaptured } from "#scripts/script-process.mts";

const KEYTOOL_HINT = "keytool comes from JAVA_HOME, or from PATH when JAVA_HOME is unset.";

if (process.platform !== "darwin") {
  fail("The upload key's password lives in the macOS Keychain, so create the key on a Mac.");
}

const keytool =
  process.env["JAVA_HOME"] === undefined
    ? "keytool"
    : path.join(process.env["JAVA_HOME"], "bin", "keytool");

const existingUploadKeyParts = [
  ...(fs.existsSync(KEYSTORE_PATH) ? [`the keystore ${KEYSTORE_PATH}`] : []),
  ...(checkKeychainItem() ? [KEYCHAIN_ITEM_DESCRIPTION] : []),
];
if (existingUploadKeyParts.length > 0) {
  fail(
    `Refusing to create the upload key, because ${existingUploadKeyParts.join(" and ")} already ${existingUploadKeyParts.length > 1 ? "exist" : "exists"}. Nothing was changed. To replace a lost upload key, follow the upload key reset in docs/production-configuration.md#upload-key-reset.`,
  );
}

const password = crypto.randomBytes(32).toString("hex");
const keytoolEnvironment: NodeJS.ProcessEnv = { ...process.env, [PASSWORD_VARIABLE]: password };

runCaptured(
  keytool,
  [
    "-genkeypair",
    "-keystore",
    KEYSTORE_PATH,
    "-storetype",
    "PKCS12",
    "-storepass:env",
    PASSWORD_VARIABLE,
    "-keypass:env",
    PASSWORD_VARIABLE,
    "-alias",
    KEY_ALIAS,
    "-keyalg",
    "RSA",
    "-keysize",
    "4096",
    "-validity",
    "10000",
    "-dname",
    "CN=Cup",
    "-noprompt",
  ],
  { env: keytoolEnvironment, failureHint: KEYTOOL_HINT },
);
fs.chmodSync(KEYSTORE_PATH, 0o600);

const keychainAddResult = childProcess.spawnSync("security", ["-i"], {
  input: `add-generic-password -s "${KEYCHAIN_SERVICE}" -a "${KEYCHAIN_ACCOUNT}" -l "Cup Android upload key" -w ${password}\n`,
  encoding: "utf8",
});
const passwordStoreFailure = findPasswordStoreFailure(keychainAddResult);

if (passwordStoreFailure !== undefined) {
  fs.rmSync(KEYSTORE_PATH);
  fail(
    `Storing the password in ${KEYCHAIN_ITEM_DESCRIPTION} failed, so the new keystore was deleted again:\n${passwordStoreFailure}`,
  );
}

const certificate = runCaptured(
  keytool,
  [
    "-J-Duser.language=en",
    "-list",
    "-v",
    "-keystore",
    KEYSTORE_PATH,
    "-storepass:env",
    PASSWORD_VARIABLE,
    "-alias",
    KEY_ALIAS,
  ],
  { env: keytoolEnvironment, failureHint: KEYTOOL_HINT },
);
const sha1 = /^\s*SHA1:\s*(\S+)/m.exec(certificate)?.[1];
const sha256 = /^\s*SHA256:\s*(\S+)/m.exec(certificate)?.[1];

if (sha1 === undefined || sha256 === undefined) {
  fail(
    `Created the upload key, but found no SHA-1 and SHA-256 fingerprints in keytool's output. Print them with \`${keytool} -list -v -keystore ${KEYSTORE_PATH} -alias ${KEY_ALIAS}\`.`,
  );
}

console.log(`Created the upload key.

Certificate fingerprints:
  SHA-1:   ${sha1}
  SHA-256: ${sha256}

Back up both as one entry in your password manager:
  - the keystore file ${KEYSTORE_PATH}
  - its password, in ${KEYCHAIN_ITEM_DESCRIPTION}
    (show it with \`security find-generic-password -s ${KEYCHAIN_SERVICE} -a ${KEYCHAIN_ACCOUNT} -w\`)`);

function checkKeychainItem(): boolean {
  try {
    return hasKeychainItem();
  } catch (error) {
    return fail(
      `Looking up ${KEYCHAIN_ITEM_DESCRIPTION} failed, so nothing was changed: ${describeError(error)}`,
    );
  }
}

function findPasswordStoreFailure(
  securityAddResult: childProcess.SpawnSyncReturns<string>,
): string | undefined {
  if (securityAddResult.status !== 0) {
    return securityAddResult.stderr;
  }

  try {
    return hasKeychainItem() ? undefined : "`security` succeeded, but the item is missing.";
  } catch (error) {
    return `Looking up the stored item failed: ${describeError(error)}`;
  }
}

function describeError(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

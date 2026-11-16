/* oxlint-disable node/no-process-env -- The script finds keytool through JAVA_HOME and hands keytool the password through its environment. */
/*
 * Creates the Android upload key once: a PKCS12 keystore in the Android project, whose random
 * password lives only in the macOS Keychain. See the README's "Release builds".
 * `.mts` because this package is CommonJS for `capacitor.config.ts`.
 */
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
  KEYSTORE,
  PASSWORD_VARIABLE,
} from "#scripts/release/upload-key.mts";

if (process.platform !== "darwin") {
  fail("The upload key's password lives in the macOS Keychain, so create the key on a Mac.");
}

const keytool =
  process.env["JAVA_HOME"] === undefined
    ? "keytool"
    : path.join(process.env["JAVA_HOME"], "bin", "keytool");

const existing = [
  ...(fs.existsSync(KEYSTORE) ? [`the keystore ${KEYSTORE}`] : []),
  ...(hasKeychainItem() ? [KEYCHAIN_ITEM_DESCRIPTION] : []),
];
if (existing.length > 0) {
  fail(
    `Refusing to create the upload key, because ${existing.join(" and ")} already ${existing.length > 1 ? "exist" : "exists"}. Nothing was changed. To replace a lost upload key, follow the upload key reset in docs/production-configuration.md.`,
  );
}

// Hex, so the password needs no quoting in `security -i` and has no leading dash.
const password = crypto.randomBytes(32).toString("hex");
const keytoolEnvironment: NodeJS.ProcessEnv = { ...process.env, [PASSWORD_VARIABLE]: password };

// The keystore first: if storing the password fails, deleting the new file undoes the run, so a retry passes the check above.
run(
  keytool,
  [
    "-genkeypair",
    "-keystore",
    KEYSTORE,
    "-storetype",
    "PKCS12",
    // PKCS12 uses one password for the store and the key.
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
  keytoolEnvironment,
);
fs.chmodSync(KEYSTORE, 0o600);

// `security -i` reads the command from stdin, so the password never appears in a process list.
const added = childProcess.spawnSync("security", ["-i"], {
  input: `add-generic-password -s "${KEYCHAIN_SERVICE}" -a "${KEYCHAIN_ACCOUNT}" -l "Cup Android upload key" -w ${password}\n`,
  encoding: "utf8",
});
if (added.status !== 0 || !hasKeychainItem()) {
  fs.rmSync(KEYSTORE);
  fail(
    `Storing the password in ${KEYCHAIN_ITEM_DESCRIPTION} failed, so the new keystore was deleted again:\n${added.stderr}`,
  );
}

const certificate = run(
  keytool,
  [
    // The fingerprint labels are localized; English keeps them parseable.
    "-J-Duser.language=en",
    "-list",
    "-v",
    "-keystore",
    KEYSTORE,
    "-storepass:env",
    PASSWORD_VARIABLE,
    "-alias",
    KEY_ALIAS,
  ],
  keytoolEnvironment,
);
const sha1 = /^\s*SHA1:\s*(\S+)/m.exec(certificate)?.[1];
const sha256 = /^\s*SHA256:\s*(\S+)/m.exec(certificate)?.[1];
if (sha1 === undefined || sha256 === undefined) {
  fail(
    `Created the upload key, but found no SHA-1 and SHA-256 fingerprints in keytool's output. Print them with \`${keytool} -list -v -keystore ${KEYSTORE} -alias ${KEY_ALIAS}\`.`,
  );
}

console.log(`Created the upload key.

Certificate fingerprints:
  SHA-1:   ${sha1}
  SHA-256: ${sha256}

Back up both as one entry in your password manager:
  - the keystore file ${KEYSTORE}
  - its password, in ${KEYCHAIN_ITEM_DESCRIPTION}
    (show it with \`security find-generic-password -s ${KEYCHAIN_SERVICE} -a ${KEYCHAIN_ACCOUNT} -w\`)`);

function run(command: string, args: readonly string[], env: NodeJS.ProcessEnv): string {
  const result = childProcess.spawnSync(command, args, { env, encoding: "utf8" });
  if (result.error !== undefined || result.status !== 0) {
    fail(
      `\`${[command, ...args].join(" ")}\` failed${result.error === undefined ? ` with exit status ${String(result.status)}` : `: ${result.error.message}`}. keytool comes from JAVA_HOME, or from PATH when JAVA_HOME is unset.\n${result.stdout}${result.stderr}`,
    );
  }
  return result.stdout;
}

function fail(message: string): never {
  console.error(message);
  process.exit(1);
}

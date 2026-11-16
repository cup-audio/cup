/* oxlint-disable node/no-process-env -- The script reads the host's Android SDK location and hands Gradle the upload key through its environment. */
/*
 * Turns a clean, pushed commit into a release-signed Android App Bundle for Google Play's internal
 * testing track. See the README's "Release builds". `.mts` because this package is CommonJS for
 * `capacitor.config.ts`.
 */
import childProcess from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import util from "node:util";
import { Temporal } from "temporal-polyfill";

import { findBundleViolations } from "#scripts/release/bundle-safety-check.mts";
import { findFailedReleasePreconditions } from "#scripts/release/release-preconditions.mts";
import type { ReleaseGit } from "#scripts/release/release-preconditions.mts";
import { deriveReleaseVersion, formatReleaseName } from "#scripts/release/release-version.mts";
import {
  KEYSTORE,
  KEYSTORE_PATH_VARIABLE,
  PASSWORD_VARIABLE,
  readKeystorePassword,
  UPLOAD_KEY_STORE,
} from "#scripts/release/upload-key.mts";

const MOBILE_APP_ROOT = path.resolve(import.meta.dirname, "..");
const REPOSITORY_ROOT = path.resolve(MOBILE_APP_ROOT, "..", "..");
const ANDROID_PROJECT = path.join(MOBILE_APP_ROOT, "android");
const BUNDLE = path.join(
  ANDROID_PROJECT,
  "app",
  "build",
  "outputs",
  "bundle",
  "release",
  "app-release.aab",
);
// The manifest Gradle merges into the bundle, as plain XML; the bundle itself holds it as protobuf.
const RELEASE_MANIFEST = path.join(
  ANDROID_PROJECT,
  "app",
  "build",
  "intermediates",
  "bundle_manifest",
  "release",
  "processApplicationManifestReleaseForBundle",
  "AndroidManifest.xml",
);
const DEFAULT_SDK_ROOT = path.join(os.homedir(), "Library", "Android", "sdk");
const SETUP_DOCS = `${path.join(MOBILE_APP_ROOT, "README.md")}, section "Release builds"`;

const GIT: ReleaseGit = {
  hasTrackedChanges: () =>
    runCaptured("git", ["status", "--porcelain", "--untracked-files=no"]).trim() !== "",
  remoteBranchesContainingHead: () =>
    runCaptured("git", ["branch", "--remotes", "--contains", "HEAD", "--format=%(refname:short)"])
      .split("\n")
      .filter((branch) => branch !== ""),
};

const { values: options } = util.parseArgs({
  options: { "skip-upload": { type: "boolean", default: false } },
});

if (process.platform !== "darwin") {
  fail("The upload key's password lives in the macOS Keychain, so release from a Mac.");
}
if (!options["skip-upload"]) {
  // TODO(#446): upload the bundle to the internal testing track after the bundle safety check.
  fail(
    "Uploading to Google Play isn't implemented yet. Run `android:release --skip-upload` to build the bundle, and upload it in the Play Console.",
  );
}

console.log("Checking the environment.");
runVisible("pnpm", ["env:check"], REPOSITORY_ROOT, process.env);

const failures = findFailedReleasePreconditions({ git: GIT, uploadKey: UPLOAD_KEY_STORE });
if (failures.length > 0) {
  fail(
    `Refusing to release:\n${failures.map((failure) => `  - ${failure}`).join("\n")}\nSetup is documented in ${SETUP_DOCS}.`,
  );
}

// Read once, so `versionCode` and `versionName` describe the same instant.
const version = deriveReleaseVersion(Temporal.Now.instant());
const releaseName = formatReleaseName(
  version.versionName,
  runCaptured("git", ["rev-parse", "HEAD"]).trim(),
);
console.log(`Building ${releaseName}, versionCode ${String(version.versionCode)}.`);

const environment: NodeJS.ProcessEnv = {
  ...process.env,
  // Gradle reads the SDK from ANDROID_HOME, so no `local.properties` is needed; the lookup order matches `android-run.mts`.
  ANDROID_HOME: process.env["ANDROID_HOME"] ?? process.env["ANDROID_SDK_ROOT"] ?? DEFAULT_SDK_ROOT,
};
runVisible("pnpm", ["exec", "turbo", "run", "turbo:build"], MOBILE_APP_ROOT, environment);
runVisible("pnpm", ["exec", "cap", "sync", "android"], MOBILE_APP_ROOT, environment);

// A stale bundle or manifest must not pass for this build's if Gradle writes none.
fs.rmSync(BUNDLE, { force: true });
fs.rmSync(RELEASE_MANIFEST, { force: true });
runVisible(
  "./gradlew",
  [
    "bundleRelease",
    "--console=plain",
    `-PcupVersionCode=${String(version.versionCode)}`,
    `-PcupVersionName=${version.versionName}`,
  ],
  ANDROID_PROJECT,
  // The upload key goes in the environment, never in arguments that the process list shows (`android/app/build.gradle`).
  {
    ...environment,
    [KEYSTORE_PATH_VARIABLE]: KEYSTORE,
    [PASSWORD_VARIABLE]: readKeystorePassword(),
  },
);
if (!fs.existsSync(BUNDLE)) {
  fail(`Gradle succeeded but wrote no bundle at ${BUNDLE}.`);
}

if (!fs.existsSync(RELEASE_MANIFEST)) {
  fail(`Gradle succeeded but wrote no merged release manifest at ${RELEASE_MANIFEST}.`);
}

console.log("Checking the bundle for debug hooks and native code.");
const violations = findBundleViolations({
  manifestXml: fs.readFileSync(RELEASE_MANIFEST, "utf8"),
  bundle: fs.readFileSync(BUNDLE),
});
if (violations.length > 0) {
  fail(
    `Refusing the bundle ${BUNDLE}:\n${violations.map((violation) => `  - ${violation}`).join("\n")}\nThe bundle safety check is documented in ${SETUP_DOCS}.`,
  );
}

console.log(`Built the release-signed bundle.

Bundle:       ${BUNDLE}
Release name: ${releaseName}`);

function runVisible(
  command: string,
  args: readonly string[],
  cwd: string,
  env: NodeJS.ProcessEnv,
): void {
  const result = childProcess.spawnSync(command, args, { cwd, env, stdio: "inherit" });
  if (result.status !== 0) {
    fail(`\`${[command, ...args].join(" ")}\` exited with ${String(result.status)}.`);
  }
}

function runCaptured(command: string, args: readonly string[]): string {
  const result = childProcess.spawnSync(command, args, { cwd: MOBILE_APP_ROOT, encoding: "utf8" });
  if (result.status !== 0) {
    fail(
      `\`${[command, ...args].join(" ")}\` exited with ${String(result.status)}.\n${result.stdout}${result.stderr}`,
    );
  }
  return result.stdout;
}

function fail(message: string): never {
  console.error(message);
  process.exit(1);
}

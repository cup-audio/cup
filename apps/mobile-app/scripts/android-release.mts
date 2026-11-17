/* oxlint-disable node/no-process-env -- The script hands Gradle the upload key through its environment. */
/*
 * Turns a clean, pushed commit into a release-signed Android App Bundle for Google Play's internal
 * testing track. See the README's "Release builds". `.mts` because this package is CommonJS for
 * `capacitor.config.ts`.
 */
import fs from "node:fs";
import path from "node:path";
import util from "node:util";
import { Temporal } from "temporal-polyfill";

import { requireJvmToolchain } from "#scripts/jvm-toolchain.mts";
import { findBundleViolations } from "#scripts/release/bundle-safety-check.mts";
import {
  createGooglePlayPublisher,
  UPLOADER_SERVICE_ACCOUNT,
} from "#scripts/release/google-play-publisher.mts";
import { uploadToInternalTesting } from "#scripts/release/play-upload.mts";
import type { PlayPublisher } from "#scripts/release/play-upload.mts";
import { findFailedReleasePreconditions } from "#scripts/release/release-preconditions.mts";
import type { ReleaseGit } from "#scripts/release/release-preconditions.mts";
import { deriveReleaseVersion, formatReleaseName } from "#scripts/release/release-version.mts";
import { readProguardUuid } from "#scripts/release/sentry-debug-meta.mts";
import {
  KEYSTORE_PATH,
  KEYSTORE_PATH_VARIABLE,
  PASSWORD_VARIABLE,
  readKeystorePassword,
  UPLOAD_KEY_STORE,
} from "#scripts/release/upload-key.mts";
import { fail, MOBILE_APP_ROOT, runCaptured, runVisible } from "#scripts/script-process.mts";

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
// The merged release manifest Gradle packages, as plain XML; the bundle itself holds it as protobuf.
const RELEASE_MANIFEST = path.join(
  ANDROID_PROJECT,
  "app",
  "build",
  "intermediates",
  "packaged_manifests",
  "release",
  "processReleaseManifestForPackage",
  "AndroidManifest.xml",
);
const MAPPING_FILE = path.join(
  ANDROID_PROJECT,
  "app",
  "build",
  "outputs",
  "mapping",
  "release",
  "mapping.txt",
);
// Every class here is a debug hook that a release bundle must not contain.
const DEBUG_SOURCES = path.join(ANDROID_PROJECT, "app", "src", "debug", "java");
const SETUP_DOCS = `${path.join(MOBILE_APP_ROOT, "README.md")}, section "Release builds"`;

const GIT_COMMAND_LINE_ADAPTER: ReleaseGit = {
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

console.log("Checking the environment.");
runVisible("pnpm", ["env:check"], { cwd: REPOSITORY_ROOT, env: process.env });

const failures = findFailedReleasePreconditions({
  git: GIT_COMMAND_LINE_ADAPTER,
  uploadKey: UPLOAD_KEY_STORE,
});
if (failures.length > 0) {
  fail(
    `Refusing to release:\n${failures.map((failure) => `  - ${failure}`).join("\n")}\nSetup is documented in ${SETUP_DOCS}.`,
  );
}

// Exits with every problem when the Android SDK or Java 21 is missing, before the build starts.
const androidSdkRoot = requireJvmToolchain();

// Reads the credentials before the build, so missing ones fail before Gradle starts rather than after it.
const publisher = options["skip-upload"] ? undefined : await createPublisher();
if (publisher !== undefined) {
  // `symbols:upload` runs `sentry-cli info` again before uploading; this fails before the build instead.
  runCaptured("pnpm", ["--filter", "@cup/source-maps", "exec", "sentry-cli", "info"], {
    failureHint: `Sentry CLI has no working upload token; set it up as for the deploy (docs/production-configuration.md#deploy). Setup is documented in ${SETUP_DOCS}.`,
  });
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
  // Gradle reads the SDK from ANDROID_HOME, so no `local.properties` is needed.
  ANDROID_HOME: androidSdkRoot,
};
runVisible("pnpm", ["exec", "turbo", "run", "turbo:build"], {
  cwd: MOBILE_APP_ROOT,
  env: environment,
});
runVisible("pnpm", ["exec", "cap", "sync", "android"], { cwd: MOBILE_APP_ROOT, env: environment });

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
  {
    cwd: ANDROID_PROJECT,
    // The upload key goes in the environment, never in arguments that the process list shows (`android/app/build.gradle`).
    env: {
      ...environment,
      [KEYSTORE_PATH_VARIABLE]: KEYSTORE_PATH,
      [PASSWORD_VARIABLE]: readKeystorePassword(),
    },
  },
);

if (!fs.existsSync(BUNDLE)) {
  fail(`Gradle succeeded but wrote no bundle at ${BUNDLE}.`);
}

if (!fs.existsSync(RELEASE_MANIFEST)) {
  fail(`Gradle succeeded but wrote no merged release manifest at ${RELEASE_MANIFEST}.`);
}

console.log("Checking the bundle for debug hooks and native code.");
const bundle = fs.readFileSync(BUNDLE);
const violations = findBundleViolations({
  debugClassNames: listDebugClassNames(),
  manifestXml: fs.readFileSync(RELEASE_MANIFEST, "utf8"),
  bundle,
});

if (violations.length > 0) {
  fail(
    `Refusing the bundle ${BUNDLE}:\n${violations.map((violation) => `  - ${violation}`).join("\n")}\nThe bundle safety check is documented in ${SETUP_DOCS}.`,
  );
}

if (!fs.existsSync(MAPPING_FILE)) {
  fail(`Gradle succeeded but wrote no R8 mapping file at ${MAPPING_FILE}.`);
}

const symbolsUploadArgs = [
  "run",
  "symbols:upload",
  "android",
  "--android-mapping",
  MAPPING_FILE,
  "--android-proguard-uuid",
  readProguardUuidOrFail(bundle),
];

if (publisher === undefined) {
  console.log(`Built the release-signed bundle and skipped the uploads. Before uploading it to a store by hand, upload its symbols to Sentry:
  pnpm --filter @cup/mobile-app ${symbolsUploadArgs.join(" ")}`);
} else {
  // Sentry gets the symbols first: a failure here stops the release before Play sees it.
  console.log("Uploading the release's R8 mapping file and web source maps to Sentry.");
  runVisible("pnpm", symbolsUploadArgs, { cwd: MOBILE_APP_ROOT, env: process.env });

  console.log(`Uploading ${releaseName} to Google Play's internal testing track.`);

  try {
    await uploadToInternalTesting({
      publisher,
      bundlePath: BUNDLE,
      versionCode: version.versionCode,
      releaseName,
    });
  } catch (error) {
    fail(
      `Uploading to Google Play failed; Play applies nothing from an edit whose commit didn't succeed:\n${util.inspect(error)}\nThe bundle stays at ${BUNDLE}. Uploads are documented in ${SETUP_DOCS}.`,
    );
  }

  console.log("Rolled out the release to every tester of the internal testing track.");
}

console.log(`
Bundle:       ${BUNDLE}
Release name: ${releaseName}`);

async function createPublisher(): Promise<PlayPublisher> {
  try {
    return await createGooglePlayPublisher();
  } catch (error) {
    return fail(
      `Reading your Google application-default credentials failed:\n${util.inspect(error)}\nSign in with \`gcloud auth application-default login\`; uploads impersonate ${UPLOADER_SERVICE_ACCOUNT} through them. Setup is documented in ${SETUP_DOCS}.`,
    );
  }
}

function readProguardUuidOrFail(releaseBundle: Buffer): string {
  try {
    return readProguardUuid(releaseBundle);
  } catch (error) {
    return fail(error instanceof Error ? error.message : String(error));
  }
}

/** The debug source set's classes, fully qualified, from its Java and Kotlin file paths. */
function listDebugClassNames(): string[] {
  return fs
    .readdirSync(DEBUG_SOURCES, { recursive: true, encoding: "utf8" })
    .filter((file) => /\.(?:java|kt)$/.test(file))
    .map((file) =>
      file
        .replace(/\.(?:java|kt)$/, "")
        .split(path.sep)
        .join("."),
    );
}

import childProcess from "node:child_process";
import fs from "node:fs/promises";
import path from "node:path";
import url from "node:url";

/** Runs Sentry CLI with these arguments to completion and resolves with its exit code. */
export type RunSentryCli = (args: string[]) => Promise<number>;

/** A release build of one shell, made after `pnpm --filter @cup/mobile-app build`. */
export type ShellSymbolsTarget =
  | {
      platform: "ios";
      /** The Xcode archive (`.xcarchive`) whose app goes to App Store Connect. */
      archive: string;
      /** The web build's source maps, `apps/web-app/dist/source-maps`. */
      webSourceMapDir: string;
    }
  | {
      platform: "android";
      /** The web bundle `cap sync` packed into the Android project, which the release build ships. */
      packedWebDir: string;
      /** The web build's source maps, `apps/web-app/dist/source-maps`. */
      webSourceMapDir: string;
    };

const SENTRY_CLI = url.fileURLToPath(import.meta.resolve("@sentry/cli/bin/sentry-cli"));
const SENTRY_PROJECT = "cup-app";
const DEBUG_ID_COMMENT = /\n\/\/# debugId=([0-9a-f-]{36})\s*$/;

/**
 * Uploads what Sentry needs to symbolicate a shell release: the iOS archive's dSYMs and the source
 * maps of the web bundle packed into the build. Any failure throws before the operator uploads the
 * build to the store; debug IDs, not releases, match the files to events, so no release is named.
 */
export async function uploadShellSymbols(
  target: ShellSymbolsTarget,
  runSentryCli: RunSentryCli,
): Promise<void> {
  const packedWebDir =
    target.platform === "ios" ? await findPackedWebDir(target.archive) : target.packedWebDir;
  await assertSourceMapsMatchPackedBundle(packedWebDir, target.webSourceMapDir);

  const steps: string[][] = [["info"]];
  if (target.platform === "ios") {
    const dsymDir = path.join(target.archive, "dSYMs");
    await assertHasDsym(dsymDir);
    // `--wait` waits until Sentry has processed the files, so a processing error fails the step too.
    steps.push(["debug-files", "upload", "--project", SENTRY_PROJECT, "--wait", dsymDir]);
  }
  steps.push([
    "sourcemaps",
    "upload",
    "--project",
    SENTRY_PROJECT,
    "--strict",
    packedWebDir,
    target.webSourceMapDir,
  ]);

  for (const args of steps) {
    const exitCode = await runSentryCli(args);
    if (exitCode !== 0) {
      throw new Error(
        `\`sentry-cli ${args.join(" ")}\` failed with exit code ${exitCode}. Do not upload this build to the store.`,
      );
    }
  }
}

/**
 * Runs the workspace's Sentry CLI. By default it inherits the operator's environment, so the CLI
 * finds the upload token in `~/.sentryclirc` and the committed `.sentryclirc` above the working
 * directory.
 */
export async function spawnSentryCli(
  args: string[],
  {
    environment = process.env,
    stdio = "inherit",
  }: { environment?: NodeJS.ProcessEnv; stdio?: "inherit" | "ignore" } = {},
): Promise<number> {
  return new Promise((resolve, reject) => {
    childProcess
      .spawn(process.execPath, [SENTRY_CLI, ...args], { env: environment, stdio })
      .on("error", reject)
      .on("exit", (code) => resolve(code ?? 1));
  });
}

/**
 * Xcode archives the app at `Products/Applications/<name>.app`; Capacitor packs the web bundle in
 * its `public` folder.
 */
async function findPackedWebDir(archive: string) {
  const applicationsDir = path.join(archive, "Products/Applications");
  const apps = (await fs.readdir(applicationsDir)).filter((entry) => entry.endsWith(".app"));
  if (apps.length !== 1) {
    throw new Error(
      `Expected exactly one app in ${applicationsDir}, found ${apps.length}. Pass the .xcarchive of a Cup release archive.`,
    );
  }
  return path.join(applicationsDir, apps[0]!, "public");
}

async function assertHasDsym(dsymDir: string) {
  const dsyms = (await fs.readdir(dsymDir)).filter((entry) => entry.endsWith(".dSYM"));
  if (dsyms.length === 0) {
    throw new Error(
      `Found no dSYM in ${dsymDir}. Archive the Release configuration, which builds with "dwarf-with-dsym".`,
    );
  }
}

/**
 * The source maps are those of the last web build in this checkout, which need not be the bundle
 * that `cap sync` packed into the release. Sentry CLI would upload them anyway, so check that every
 * map's debug ID is in the packed bundle. Capacitor's own scripts carry no debug ID.
 */
async function assertSourceMapsMatchPackedBundle(packedWebDir: string, webSourceMapDir: string) {
  const sourceMapDebugIds = new Set<string>();
  for (const file of await listFiles(webSourceMapDir, ".map")) {
    const sourceMap: unknown = JSON.parse(await fs.readFile(file, "utf8"));
    if (
      typeof sourceMap === "object" &&
      sourceMap !== null &&
      "debugId" in sourceMap &&
      typeof sourceMap.debugId === "string"
    ) {
      sourceMapDebugIds.add(sourceMap.debugId);
    }
  }
  if (sourceMapDebugIds.size === 0) {
    throw new Error(
      `Found no source map with a debug ID in ${webSourceMapDir}. Run \`pnpm --filter @cup/mobile-app build\` before archiving the release.`,
    );
  }

  const packedDebugIds = new Set<string>();
  for (const file of await listFiles(packedWebDir, ".js")) {
    const debugId = (await fs.readFile(file, "utf8")).match(DEBUG_ID_COMMENT)?.[1];
    if (debugId !== undefined) {
      packedDebugIds.add(debugId);
    }
  }

  const missing = [...sourceMapDebugIds].filter((debugId) => !packedDebugIds.has(debugId));
  if (missing.length > 0) {
    throw new Error(
      `The web bundle packed in ${packedWebDir} lacks the debug IDs of ${missing.length} of ${sourceMapDebugIds.size} source maps in ${webSourceMapDir}, so they belong to another web build. Build with \`pnpm --filter @cup/mobile-app build\`, archive the release from that build, then upload its symbols.`,
    );
  }
}

async function listFiles(directory: string, extension: string) {
  const entries = await fs.readdir(directory, { recursive: true, withFileTypes: true });
  return entries
    .filter((entry) => entry.isFile() && entry.name.endsWith(extension))
    .map((entry) => path.join(entry.parentPath, entry.name));
}

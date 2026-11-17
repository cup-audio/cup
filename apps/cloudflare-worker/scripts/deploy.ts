/*
 * Deploys the Worker so that no release goes live without its source maps in Sentry: check Sentry
 * auth, empty the build folders, build, upload the web and Worker source maps, and only then
 * `wrangler deploy`. Any failing step aborts before anything goes live; there is deliberately no
 * flag to deploy anyway.
 */
import childProcess from "node:child_process";
import fs from "node:fs/promises";
import path from "node:path";
import url from "node:url";

/** Runs a command to completion and resolves with its exit code. */
export type RunCommand = (command: string, args: string[]) => Promise<number>;

/** Removes a directory with everything in it; resolves as well when it does not exist. */
export type RemoveDirectory = (directory: string) => Promise<void>;

const WORKER_DIRECTORY = path.resolve(import.meta.dirname, "..");
const WEB_APP_DIRECTORY = path.dirname(
  url.fileURLToPath(import.meta.resolve("@cup/web-app/package.json")),
);

/*
 * The build output directories and their source map directories, as `prepare-source-maps` leaves
 * them in each package's `turbo:build`. The debug IDs, not the release, match maps to events, so
 * the upload names no release.
 */
/*
 * Turbo restores a cached build by writing its files over what a folder already holds and removes
 * none, so without emptying these first the upload and the deploy would carry the files of every
 * earlier build. Only the served build and its maps go; the declaration output and its build info
 * stay together, so TypeScript's incremental build keeps working.
 */
const BUILD_OUTPUT_DIRECTORIES = [
  path.join(WEB_APP_DIRECTORY, "dist/web"),
  path.join(WEB_APP_DIRECTORY, "dist/source-maps"),
  path.join(WORKER_DIRECTORY, "dist/client"),
  path.join(WORKER_DIRECTORY, "dist/create_audiobook_from_url"),
  path.join(WORKER_DIRECTORY, "dist/source-maps"),
];

const BUILD_AND_DEPLOY_STEPS: Array<{ command: string; args: string[] }> = [
  { command: "pnpm", args: ["run", "build"] },
  {
    command: "sentry-cli",
    args: [
      "sourcemaps",
      "upload",
      "--project",
      "cup-app",
      "--strict",
      path.join(WEB_APP_DIRECTORY, "dist/web"),
      path.join(WEB_APP_DIRECTORY, "dist/source-maps"),
    ],
  },
  {
    command: "sentry-cli",
    args: [
      "sourcemaps",
      "upload",
      "--project",
      "cup-worker",
      "--strict",
      path.join(WORKER_DIRECTORY, "dist/create_audiobook_from_url"),
      path.join(WORKER_DIRECTORY, "dist/source-maps"),
    ],
  },
  { command: "wrangler", args: ["deploy"] },
];

export async function deploy(
  runCommand: RunCommand,
  removeDirectory: RemoveDirectory = removeDirectoryFromDisk,
): Promise<void> {
  // The upload token lives in `~/.sentryclirc` from `sentry-cli login`; `info` fails without it.
  await runStep(runCommand, "sentry-cli", ["info"]);
  for (const directory of BUILD_OUTPUT_DIRECTORIES) {
    await removeDirectory(directory);
  }
  for (const { command, args } of BUILD_AND_DEPLOY_STEPS) {
    await runStep(runCommand, command, args);
  }
}

async function runStep(runCommand: RunCommand, command: string, args: string[]): Promise<void> {
  const exitCode = await runCommand(command, args);
  if (exitCode !== 0) {
    throw new Error(
      `\`${[command, ...args].join(" ")}\` failed with exit code ${exitCode}. Nothing was deployed.`,
    );
  }
}

async function removeDirectoryFromDisk(directory: string): Promise<void> {
  await fs.rm(directory, { recursive: true, force: true });
}

/** Runs from the Worker's directory through `pnpm run deploy`, which puts its binaries on `PATH`. */
async function spawnCommand(command: string, args: string[]): Promise<number> {
  return new Promise((resolve, reject) => {
    childProcess
      .spawn(command, args, { cwd: WORKER_DIRECTORY, stdio: "inherit" })
      .on("error", reject)
      .on("exit", (code) => resolve(code ?? 1));
  });
}

if (import.meta.main) {
  try {
    await deploy(spawnCommand);
  } catch (error) {
    console.error(error instanceof Error ? error.message : error);
    process.exitCode = 1;
  }
}

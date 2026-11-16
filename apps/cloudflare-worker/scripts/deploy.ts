/*
 * Deploys the Worker so that no release goes live without its source maps in Sentry: check Sentry
 * auth, build, upload the web and Worker source maps, and only then `wrangler deploy`. Any failing
 * step aborts before anything goes live; there is deliberately no flag to deploy anyway.
 */
import childProcess from "node:child_process";
import path from "node:path";
import url from "node:url";

/** Runs a command to completion and resolves with its exit code. */
export type RunCommand = (command: string, args: string[]) => Promise<number>;

const WORKER_DIRECTORY = path.resolve(import.meta.dirname, "..");
const WEB_APP_DIRECTORY = path.dirname(
  url.fileURLToPath(import.meta.resolve("@cup/web-app/package.json")),
);

/*
 * The build output directories and their source map directories, as `prepare-source-maps` leaves
 * them in each package's `turbo:build`. The debug IDs, not the release, match maps to events, so
 * the upload names no release.
 */
const STEPS: Array<{ command: string; args: string[] }> = [
  // The upload token lives in `~/.sentryclirc` from `sentry-cli login`; `info` fails without it.
  { command: "sentry-cli", args: ["info"] },
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

export async function deploy(runCommand: RunCommand): Promise<void> {
  for (const { command, args } of STEPS) {
    const exitCode = await runCommand(command, args);
    if (exitCode !== 0) {
      throw new Error(
        `\`${[command, ...args].join(" ")}\` failed with exit code ${exitCode}. Nothing was deployed.`,
      );
    }
  }
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

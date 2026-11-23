import childProcess from "node:child_process";
import fs from "node:fs/promises";
import path from "node:path";
import url from "node:url";

export type RunCommand = (command: string, args: string[]) => Promise<number>;

export type RemoveDirectory = (directory: string) => Promise<void>;

const WORKER_DIRECTORY = path.resolve(import.meta.dirname, "..");
const WEB_APP_DIRECTORY = path.dirname(
  url.fileURLToPath(import.meta.resolve("@cup/web-app/package.json")),
);

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

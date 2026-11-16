import childProcess from "node:child_process";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import url from "node:url";
import { expect, test } from "vitest";

import { deploy, type RunCommand } from "#scripts/deploy.ts";

const WORKER_DIRECTORY = url.fileURLToPath(new URL("..", import.meta.url));
const WEB_APP_DIRECTORY = path.dirname(
  url.fileURLToPath(import.meta.resolve("@cup/web-app/package.json")),
);

test("checks Sentry auth, builds, uploads the web and Worker source maps, then deploys", async () => {
  const { runCommand, commands } = recordCommands();

  await deploy(runCommand);

  expect(commands).toEqual([
    "sentry-cli info",
    "pnpm run build",
    `sentry-cli sourcemaps upload --project cup-app --strict ${path.join(WEB_APP_DIRECTORY, "dist/web")} ${path.join(WEB_APP_DIRECTORY, "dist/source-maps")}`,
    `sentry-cli sourcemaps upload --project cup-worker --strict ${path.join(WORKER_DIRECTORY, "dist/create_audiobook_from_url")} ${path.join(WORKER_DIRECTORY, "dist/source-maps")}`,
    "wrangler deploy",
  ]);
});

test.for([
  { failing: "sentry-cli info", ran: ["sentry-cli info"] },
  { failing: "pnpm run build", ran: ["sentry-cli info", "pnpm run build"] },
  {
    failing: "sentry-cli sourcemaps upload --project cup-app",
    ran: ["sentry-cli info", "pnpm run build", "sentry-cli sourcemaps upload --project cup-app"],
  },
  {
    failing: "sentry-cli sourcemaps upload --project cup-worker",
    ran: [
      "sentry-cli info",
      "pnpm run build",
      "sentry-cli sourcemaps upload --project cup-app",
      "sentry-cli sourcemaps upload --project cup-worker",
    ],
  },
])("aborts before `wrangler deploy` when `$failing` fails", async ({ failing, ran }) => {
  const { runCommand, commands } = recordCommands(failing);

  await expect(deploy(runCommand)).rejects.toThrow(
    new RegExp(`^\`${failing}[^\`]*\` failed with exit code 1\\. Nothing was deployed\\.$`),
  );

  expect(commands.map((command) => command.split(" --strict")[0])).toEqual(ran);
});

test("aborts before building when Sentry CLI has no auth token", async ({ onTestFinished }) => {
  // An empty home directory has no `~/.sentryclirc`; the URL is a local discard port, so even a
  // misconfigured run cannot reach Sentry.
  const home = await fs.mkdtemp(path.join(os.tmpdir(), "deploy-home-"));
  onTestFinished(() => fs.rm(home, { recursive: true, force: true }));
  const sentryCliEnvironment = {
    PATH: process.env["PATH"],
    HOME: home,
    SENTRY_URL: "http://127.0.0.1:9/",
    SENTRY_DISABLE_UPDATE_CHECK: "true",
  };
  const { runCommand: recordCommand, commands } = recordCommands();

  await expect(
    deploy(async (command, args) => {
      if (command !== "sentry-cli") {
        return recordCommand(command, args);
      }
      commands.push([command, ...args].join(" "));
      return runRealSentryCli(args, sentryCliEnvironment);
    }),
  ).rejects.toThrow("`sentry-cli info` failed with exit code 1. Nothing was deployed.");

  expect(commands).toEqual(["sentry-cli info"]);
});

test("the committed Sentry CLI config names only the organisation and the Germany region, never a token", async () => {
  const config = await fs.readFile(path.join(WORKER_DIRECTORY, "../../.sentryclirc"), "utf8");

  const settings = config
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line !== "" && !line.startsWith("#"));

  expect(settings).toEqual(["[defaults]", "org=cupaudio", "url=https://de.sentry.io/"]);
});

function recordCommands(failingCommand?: string) {
  const commands: string[] = [];
  const runCommand: RunCommand = async (command, args) => {
    const commandLine = [command, ...args].join(" ");
    commands.push(commandLine);
    return failingCommand !== undefined && commandLine.startsWith(failingCommand) ? 1 : 0;
  };
  return { runCommand, commands };
}

async function runRealSentryCli(args: string[], environment: Record<string, string | undefined>) {
  const sentryCli = url.fileURLToPath(import.meta.resolve("@sentry/cli/bin/sentry-cli"));
  return new Promise<number>((resolve, reject) => {
    childProcess
      .spawn(process.execPath, [sentryCli, ...args], {
        cwd: environment["HOME"],
        env: environment,
        stdio: "ignore",
      })
      .on("error", reject)
      .on("exit", (code) => resolve(code ?? 1));
  });
}

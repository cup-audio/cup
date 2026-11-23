import childProcess from "node:child_process";
import nodeModule from "node:module";
import path from "node:path";
import readline from "node:readline";
import type { Readable, Writable } from "node:stream";

const PLATFORMS = ["android", "ios"] as const;

const PACKAGE_ROOT = path.resolve(import.meta.dirname, "..");
const require = nodeModule.createRequire(import.meta.url);
const VITEST_CLI = path.join(path.dirname(require.resolve("vitest/package.json")), "vitest.mjs");

const vitestArgs = process.argv.slice(2);
const namesProject = vitestArgs.some((arg) => arg === "--project" || arg.startsWith("--project="));

if (namesProject) {
  const vitest = childProcess.spawn(process.execPath, [VITEST_CLI, "run", ...vitestArgs], {
    cwd: PACKAGE_ROOT,
    stdio: "inherit",
  });
  process.on("SIGTERM", () => vitest.kill("SIGTERM"));
  process.exitCode = await waitForExit(vitest);
} else {
  const environment = process.stdout.isTTY ? { ...process.env, FORCE_COLOR: "1" } : process.env;
  const runs = PLATFORMS.map((platform) => {
    const vitest = childProcess.spawn(
      process.execPath,
      [VITEST_CLI, "run", "--project", platform, ...vitestArgs],
      { cwd: PACKAGE_ROOT, env: environment, stdio: ["ignore", "pipe", "pipe"] },
    );
    prefixLines(vitest.stdout, process.stdout, platform);
    prefixLines(vitest.stderr, process.stderr, platform);
    return { platform, vitest };
  });
  process.on("SIGINT", () => {});
  process.on("SIGTERM", () => {
    for (const { vitest } of runs) {
      vitest.kill("SIGTERM");
    }
  });

  const exitCodes = await Promise.all(runs.map(({ vitest }) => waitForExit(vitest)));
  const failedPlatforms = runs
    .filter((_, index) => exitCodes[index] !== 0)
    .map(({ platform }) => platform);
  if (failedPlatforms.length > 0) {
    process.stderr.write(`Mobile E2E failed on ${failedPlatforms.join(" and ")}.\n`);
    process.exitCode = 1;
  } else {
    process.stdout.write(`Mobile E2E passed on ${PLATFORMS.join(" and ")}.\n`);
  }
}

function prefixLines(input: Readable, output: Writable, platform: string): void {
  const lines = readline.createInterface({ input, crlfDelay: Infinity });
  lines.on("line", (line) => output.write(`[${platform}] ${line}\n`));
}

async function waitForExit(child: childProcess.ChildProcess): Promise<number> {
  return new Promise((resolve, reject) => {
    child.on("error", reject);
    child.on("close", (exitCode) => resolve(exitCode ?? 1));
  });
}

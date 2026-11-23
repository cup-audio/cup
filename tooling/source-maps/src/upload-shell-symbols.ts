import childProcess from "node:child_process";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import url from "node:url";

export type RunSentryCli = (args: string[]) => Promise<number>;

export type ShellSymbolsTarget =
  | {
      platform: "ios";
      archive: string;
      webSourceMapDir: string;
    }
  | {
      platform: "android";
      packedWebDir: string;
      webSourceMapDir: string;
      mappingFile: string;
      proguardUuid: string;
    };

const SENTRY_CLI = url.fileURLToPath(import.meta.resolve("@sentry/cli/bin/sentry-cli"));
const SENTRY_PROJECT = "cup-app";
const DEBUG_ID_COMMENT = /\n\/\/# debugId=([0-9a-f-]{36})\s*$/;

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
    steps.push(["debug-files", "upload", "--project", SENTRY_PROJECT, "--wait", dsymDir]);
  } else {
    await assertMappingMatchesBuild(target.mappingFile, target.proguardUuid, runSentryCli);
    steps.push([
      "proguard",
      "upload",
      "--project",
      SENTRY_PROJECT,
      "--require-one",
      target.mappingFile,
    ]);
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

async function assertMappingMatchesBuild(
  mappingFile: string,
  proguardUuid: string,
  runSentryCli: RunSentryCli,
) {
  const workDir = await fs.mkdtemp(path.join(os.tmpdir(), "proguard-uuid-"));
  try {
    const propertiesFile = path.join(workDir, "sentry-debug-meta.properties");
    const args = ["proguard", "upload", "--no-upload", "--write-properties", propertiesFile];
    const exitCode = await runSentryCli([...args, mappingFile]);
    if (exitCode !== 0) {
      throw new Error(
        `\`sentry-cli ${[...args, mappingFile].join(" ")}\` failed with exit code ${exitCode}. Do not upload this build to the store.`,
      );
    }

    const mappingUuid = (await fs.readFile(propertiesFile, "utf8")).match(
      /^io\.sentry\.ProguardUuids=([0-9a-f-]{36})\s*$/m,
    )?.[1];
    if (mappingUuid !== proguardUuid) {
      throw new Error(
        `The mapping file ${mappingFile} has the ProGuard UUID ${mappingUuid ?? "(none)"}, but the build embedded ${proguardUuid}, so they belong to different builds. Upload the symbols of the build you upload to the store.`,
      );
    }
  } finally {
    await fs.rm(workDir, { recursive: true, force: true });
  }
}

async function assertHasDsym(dsymDir: string) {
  const dsyms = (await fs.readdir(dsymDir)).filter((entry) => entry.endsWith(".dSYM"));
  if (dsyms.length === 0) {
    throw new Error(
      `Found no dSYM in ${dsymDir}. Archive the Release configuration, which builds with "dwarf-with-dsym".`,
    );
  }
}

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

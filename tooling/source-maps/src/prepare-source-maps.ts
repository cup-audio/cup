import childProcess from "node:child_process";
import fs from "node:fs/promises";
import path from "node:path";
import url from "node:url";
import util from "node:util";

export type PrepareSourceMapsOptions = {
  /** A build output that is served, deployed or packed into the shells, such as `dist/web`. */
  buildDir: string;
  /** Receives every `.map` file of the build output, at the same relative path. */
  sourceMapDir: string;
};

const SENTRY_CLI = url.fileURLToPath(import.meta.resolve("@sentry/cli/bin/sentry-cli"));
const SOURCE_MAP_EXTENSION = ".map";

/**
 * Injects a Sentry debug ID into every JavaScript file of a build output and into its source map,
 * then moves the source maps into a directory that is never served or deployed. The deploy uploads
 * them from there (apps/cloudflare-worker/scripts/deploy.ts).
 */
export async function prepareSourceMaps(
  { buildDir, sourceMapDir }: PrepareSourceMapsOptions,
  output: Pick<Console, "log">,
): Promise<void> {
  const sourceMaps = await listSourceMaps(buildDir);
  if (sourceMaps.length === 0) {
    throw new Error(
      `Found no source map in ${buildDir}. Build with \`build.sourcemap: "hidden"\`, so that the deploy can upload one per chunk.`,
    );
  }

  await injectDebugIds(buildDir);

  await fs.rm(sourceMapDir, { recursive: true, force: true });
  for (const sourceMap of sourceMaps) {
    const target = path.join(sourceMapDir, sourceMap);
    await fs.mkdir(path.dirname(target), { recursive: true });
    await fs.rename(path.join(buildDir, sourceMap), target);
  }
  output.log(`Moved ${sourceMaps.length} source maps from ${buildDir} to ${sourceMapDir}.`);
}

async function listSourceMaps(directory: string) {
  const entries = await fs.readdir(directory, { recursive: true, withFileTypes: true });
  return entries
    .filter((entry) => entry.isFile() && entry.name.endsWith(SOURCE_MAP_EXTENSION))
    .map((entry) => path.relative(directory, path.join(entry.parentPath, entry.name)))
    .toSorted();
}

/**
 * Sentry CLI derives each debug ID from the file's content, so an unchanged build injects the same
 * IDs and stays cacheable. With `build.sourcemap: "hidden"` the chunks name no source map; the CLI
 * finds each one next to its chunk.
 */
async function injectDebugIds(directory: string) {
  try {
    await util.promisify(childProcess.execFile)(
      process.execPath,
      [SENTRY_CLI, "sourcemaps", "inject", "--quiet", directory],
      // The injection is local; no update check or other request leaves the machine.
      { env: { ...process.env, SENTRY_DISABLE_UPDATE_CHECK: "true" } },
    );
  } catch (error) {
    throw new Error(`\`sentry-cli sourcemaps inject ${directory}\` failed.`, { cause: error });
  }
}

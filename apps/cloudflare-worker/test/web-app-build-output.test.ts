import fs from "node:fs/promises";
import path from "node:path";
import url from "node:url";
import { expect, test } from "vitest";

/*
 * The Worker serves the web app's build output as its static assets, and `cap sync` packs the same
 * directory into the shells. Turbo builds it before this package's tests (`^turbo:build`).
 */
const WEB_APP_DIRECTORY = path.dirname(
  url.fileURLToPath(import.meta.resolve("@cup/web-app/package.json")),
);
const SERVED_WEB_OUTPUT = path.join(WEB_APP_DIRECTORY, "dist/web");
const WEB_SOURCE_MAPS = path.join(WEB_APP_DIRECTORY, "dist/source-maps");

test("the served web output holds no source map", async () => {
  const files = await listFiles(SERVED_WEB_OUTPUT);

  expect(files).toContain("index.html");
  expect(files.filter((file) => file.endsWith(".map"))).toEqual([]);
});

test("every JS chunk of the served web output carries a debug ID that its uploaded source map shares", async () => {
  const chunks = (await listFiles(SERVED_WEB_OUTPUT)).filter((file) => file.endsWith(".js"));
  const sourceMaps = new Set(await listFiles(WEB_SOURCE_MAPS));

  const chunksWithoutDebugId: string[] = [];
  const chunksWithAnotherSourceMapDebugId: string[] = [];
  for (const chunk of chunks) {
    const code = await fs.readFile(path.join(SERVED_WEB_OUTPUT, chunk), "utf8");
    const debugId = code.match(/\n\/\/# debugId=([0-9a-f-]{36})\s*$/)?.[1];
    if (debugId === undefined) {
      chunksWithoutDebugId.push(chunk);
    }

    // Rolldown's runtime and preload helpers have no source map; every other chunk has one.
    if (sourceMaps.has(`${chunk}.map`)) {
      const sourceMap: unknown = JSON.parse(
        await fs.readFile(path.join(WEB_SOURCE_MAPS, `${chunk}.map`), "utf8"),
      );
      if (!hasDebugId(sourceMap, debugId)) {
        chunksWithAnotherSourceMapDebugId.push(chunk);
      }
    }
  }

  expect(chunks.length).toBeGreaterThan(0);
  expect(sourceMaps.size).toBeGreaterThan(0);
  expect(chunksWithoutDebugId).toEqual([]);
  expect(chunksWithAnotherSourceMapDebugId).toEqual([]);
});

function hasDebugId(sourceMap: unknown, debugId: string | undefined) {
  return (
    typeof sourceMap === "object" &&
    sourceMap !== null &&
    "debugId" in sourceMap &&
    sourceMap.debugId === debugId
  );
}

async function listFiles(directory: string) {
  const entries = await fs.readdir(directory, { recursive: true, withFileTypes: true });
  return entries
    .filter((entry) => entry.isFile())
    .map((entry) => path.relative(directory, path.join(entry.parentPath, entry.name)));
}

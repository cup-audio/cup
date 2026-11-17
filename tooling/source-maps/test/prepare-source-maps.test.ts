import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { expect, test, type TestContext } from "vitest";

import { runCli } from "#src/cli.ts";

const DEBUG_ID_COMMENT = /\n\/\/# debugId=([0-9a-f-]{36})\s*$/;

test("injects a debug ID into every chunk and its source map, then moves the maps out of the served output", async ({
  onTestFinished,
}) => {
  const root = await createBuildOutput(onTestFinished, {
    "served/index.html": "<!doctype html>",
    "served/app/assets/entry-abc.js": 'import "./chunk-def.js";\nconsole.log("entry");\n',
    "served/app/assets/entry-abc.js.map": sourceMap("entry-abc.js"),
    "served/app/assets/chunk-def.js": 'console.log("chunk");\n',
    "served/app/assets/chunk-def.js.map": sourceMap("chunk-def.js"),
    // Rolldown emits its runtime helper without a source map; it still gets a debug ID.
    "served/app/assets/runtime-ghi.js": "var runtime = 1;\n",
  });

  expect(await prepare(root)).toBe(0);

  expect(await listFiles(path.join(root, "served"))).toEqual([
    "app/assets/chunk-def.js",
    "app/assets/entry-abc.js",
    "app/assets/runtime-ghi.js",
    "index.html",
  ]);
  expect(await listFiles(path.join(root, "source-maps"))).toEqual([
    "app/assets/chunk-def.js.map",
    "app/assets/entry-abc.js.map",
  ]);
  for (const chunk of ["chunk-def.js", "entry-abc.js"]) {
    const code = await fs.readFile(path.join(root, "served/app/assets", chunk), "utf8");
    const debugId = code.match(DEBUG_ID_COMMENT)?.[1];
    const map: unknown = JSON.parse(
      await fs.readFile(path.join(root, "source-maps/app/assets", `${chunk}.map`), "utf8"),
    );
    expect(debugId).toBeDefined();
    expect(map).toMatchObject({ debugId });
  }
  expect(await fs.readFile(path.join(root, "served/app/assets/runtime-ghi.js"), "utf8")).toMatch(
    DEBUG_ID_COMMENT,
  );
});

test("derives the same debug IDs from the same build output", async ({ onTestFinished }) => {
  const files = {
    "served/entry.js": 'console.log("entry");\n',
    "served/entry.js.map": sourceMap("entry.js"),
  };
  const first = await createBuildOutput(onTestFinished, files);
  const second = await createBuildOutput(onTestFinished, files);

  expect(await prepare(first)).toBe(0);
  expect(await prepare(second)).toBe(0);

  expect(await fs.readFile(path.join(first, "served/entry.js"), "utf8")).toBe(
    await fs.readFile(path.join(second, "served/entry.js"), "utf8"),
  );
});

test("replaces the source maps of an earlier build", async ({ onTestFinished }) => {
  const root = await createBuildOutput(onTestFinished, {
    "served/entry-new.js": 'console.log("new");\n',
    "served/entry-new.js.map": sourceMap("entry-new.js"),
    "source-maps/entry-old.js.map": sourceMap("entry-old.js"),
  });

  expect(await prepare(root)).toBe(0);

  expect(await listFiles(path.join(root, "source-maps"))).toEqual(["entry-new.js.map"]);
});

test("fails when the build emitted no source map", async ({ onTestFinished }) => {
  const root = await createBuildOutput(onTestFinished, {
    "served/entry.js": 'console.log("entry");\n',
  });
  const errors: string[] = [];

  expect(await prepare(root, errors)).toBe(1);

  expect(errors.join("\n")).toContain("no source map");
});

async function prepare(root: string, errors: string[] = []) {
  return runCli(
    ["--build-dir", path.join(root, "served"), "--source-map-dir", path.join(root, "source-maps")],
    { log: () => {}, error: (message: string) => errors.push(message) },
  );
}

async function createBuildOutput(
  onTestFinished: TestContext["onTestFinished"],
  files: Record<string, string>,
) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "prepare-source-maps-"));
  onTestFinished(() => fs.rm(root, { recursive: true, force: true }));
  for (const [file, content] of Object.entries(files)) {
    await fs.mkdir(path.dirname(path.join(root, file)), { recursive: true });
    await fs.writeFile(path.join(root, file), content);
  }
  return root;
}

async function listFiles(directory: string) {
  const entries = await fs.readdir(directory, { recursive: true, withFileTypes: true });
  return entries
    .filter((entry) => entry.isFile())
    .map((entry) => path.relative(directory, path.join(entry.parentPath, entry.name)))
    .toSorted();
}

function sourceMap(file: string) {
  return JSON.stringify({
    version: 3,
    file,
    sources: [`../src/${file.replace(/\.js$/, ".ts")}`],
    sourcesContent: ["console.log();"],
    names: [],
    mappings: "AAAA",
  });
}

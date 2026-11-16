import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { build, type Rolldown } from "vite";
import { expect, onTestFinished, test } from "vitest";

import { webReleasePlugin } from "#src/web-release.vite.ts";

type WebAppSources = { html: string; entry: string };

const SOURCES: WebAppSources = {
  html: '<!doctype html><html><head><title>Cup</title></head><body><script type="module" src="/main.js"></script></body></html>',
  entry: 'document.title = "Cup";\n',
};

/** Builds a minimal web app from `sources` and returns the release named in its `index.html`. */
async function buildRelease(sources: WebAppSources): Promise<string | undefined> {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "cup-web-release-"));
  onTestFinished(() => fs.rm(root, { recursive: true, force: true }));
  await fs.writeFile(path.join(root, "index.html"), sources.html);
  await fs.writeFile(path.join(root, "main.js"), sources.entry);

  const result = await build({
    root,
    configFile: false,
    logLevel: "silent",
    plugins: [webReleasePlugin()],
    build: { write: false },
  });
  const outputs: Array<Rolldown.RolldownOutput | Rolldown.RolldownWatcher> = Array.isArray(result)
    ? result
    : [result];
  const html = outputs
    .flatMap((output) => ("output" in output ? output.output : []))
    .find((file) => file.fileName === "index.html");
  if (html?.type !== "asset") {
    throw new Error("The build emitted no index.html.");
  }
  return /<meta name="cup-release" content="([^"]+)"/.exec(String(html.source))?.[1];
}

test("the release names the web bundle by the content hash of its entry chunk", async () => {
  expect(await buildRelease(SOURCES)).toMatch(/^web@[0-9a-f]{16}$/);
});

test("the release stays the same when the bundle does", async () => {
  const release = await buildRelease(SOURCES);

  expect(await buildRelease(SOURCES)).toBe(release);
  expect(
    await buildRelease({ ...SOURCES, html: SOURCES.html.replace("<title>Cup</title>", "") }),
  ).toBe(release);
});

test("the release changes when the bundle changes", async () => {
  const release = await buildRelease(SOURCES);

  expect(
    await buildRelease({ ...SOURCES, entry: 'document.title = "Cup audiobooks";\n' }),
  ).not.toBe(release);
});

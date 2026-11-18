import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, expect, test } from "vitest";

import { emptyWebBuildOutput } from "#scripts/web-build-output.mts";

const temporaryRoots: string[] = [];

afterEach(() => {
  for (const root of temporaryRoots.splice(0)) {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

function createWebAppRoot(files: string[]): string {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "web-build-output-"));
  temporaryRoots.push(root);
  for (const file of files) {
    fs.mkdirSync(path.dirname(path.join(root, file)), { recursive: true });
    fs.writeFileSync(path.join(root, file), "");
  }
  return root;
}

test("removes an earlier build's served files and source maps", () => {
  const root = createWebAppRoot([
    "dist/web/app/assets/main-OLD.js",
    "dist/source-maps/app/assets/main-OLD.js.map",
  ]);

  emptyWebBuildOutput(root);

  expect(fs.existsSync(path.join(root, "dist/web"))).toBe(false);
  expect(fs.existsSync(path.join(root, "dist/source-maps"))).toBe(false);
});

test("keeps the declaration output and its build info, so TypeScript's incremental build keeps working", () => {
  const root = createWebAppRoot(["dist/types/index.d.ts", "dist/tsconfig.build.tsbuildinfo"]);

  emptyWebBuildOutput(root);

  expect(fs.existsSync(path.join(root, "dist/types/index.d.ts"))).toBe(true);
  expect(fs.existsSync(path.join(root, "dist/tsconfig.build.tsbuildinfo"))).toBe(true);
});

test("succeeds when there is no earlier build", () => {
  const root = createWebAppRoot([]);

  expect(() => emptyWebBuildOutput(root)).not.toThrow();
});

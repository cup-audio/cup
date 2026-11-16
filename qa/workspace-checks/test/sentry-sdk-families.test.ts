import fs from "node:fs/promises";
import path from "node:path";
import { expect, test } from "vitest";
import { z } from "zod";

import { findSentrySdkFamilyProblems, type PackageDependencies } from "#src/sentry-sdk-families.ts";

import { listWorkspaceProjects } from "#test/workspace-projects.ts";

const manifestSchema = z.object({
  dependencies: z.record(z.string(), z.string()).optional(),
  devDependencies: z.record(z.string(), z.string()).optional(),
  peerDependencies: z.record(z.string(), z.string()).optional(),
});

async function readWorkspaceDependencies(): Promise<PackageDependencies[]> {
  const packages: PackageDependencies[] = [];
  for (const { name, directory, absolutePath } of listWorkspaceProjects()) {
    const manifest = manifestSchema.parse(
      JSON.parse(await fs.readFile(path.join(absolutePath, "package.json"), "utf8")),
    );
    packages.push({
      name,
      directory,
      dependencies: {
        ...manifest.peerDependencies,
        ...manifest.devDependencies,
        ...manifest.dependencies,
      },
    });
  }
  return packages;
}

function createPackage(name: string, dependencies: Record<string, string>): PackageDependencies {
  return { name, directory: `libs/${name.replace("@cup/", "")}`, dependencies };
}

test("every workspace package keeps the Sentry SDK families apart", async () => {
  const packages = await readWorkspaceDependencies();

  expect(packages.map((entry) => entry.name)).toContain("@cup/telemetry.cloudflare");
  expect(findSentrySdkFamilyProblems(packages)).toEqual([]);
});

test("the server telemetry library and its dependents may use the server SDK", () => {
  const packages = [
    createPackage("@cup/telemetry.cloudflare", {
      "@sentry/cloudflare": "catalog:sentry-server",
      "@sentry/core": "catalog:sentry-server",
    }),
    createPackage("@cup/cloudflare-worker", {
      "@cup/telemetry.cloudflare": "workspace:*",
      "@sentry/cloudflare": "catalog:sentry-server",
    }),
    createPackage("@cup/api-server", { "@sentry/core": "catalog:sentry-server" }),
  ];

  expect(findSentrySdkFamilyProblems(packages)).toEqual([]);
});

test("a package that uses the server SDK without the server telemetry library is reported", () => {
  const packages = [
    createPackage("@cup/registry", { "@sentry/cloudflare": "catalog:sentry-server" }),
  ];

  expect(findSentrySdkFamilyProblems(packages)).toEqual([
    "`@cup/registry` depends on `@sentry/cloudflare`; only `@cup/telemetry.cloudflare` and packages that depend on it may. Add `@cup/telemetry.cloudflare` to libs/registry/package.json, or use `@sentry/core` from the `sentry-server` catalog.",
  ]);
});

test("a package other than the browser telemetry library and the web app that uses the client SDK is reported", () => {
  const packages = [
    createPackage("@cup/telemetry.browser", { "@sentry/capacitor": "catalog:sentry-client" }),
    createPackage("@cup/web-app", { "@sentry/react": "catalog:sentry-client" }),
    createPackage("@cup/mobile-app", { "@sentry/capacitor": "catalog:sentry-client" }),
  ];

  expect(findSentrySdkFamilyProblems(packages)).toEqual([
    "`@cup/mobile-app` depends on `@sentry/capacitor`; only `@cup/telemetry.browser` and `@cup/web-app` may depend on the client SDK family.",
  ]);
});

test("a package that depends on both families is reported, whichever packages bring them", () => {
  const packages = [
    createPackage("@cup/web-app", {
      "@sentry/react": "catalog:sentry-client",
      "@sentry/core": "catalog:sentry-server",
    }),
  ];

  expect(findSentrySdkFamilyProblems(packages)).toEqual([
    "`@cup/web-app` depends on both Sentry SDK families (server: `@sentry/core`; client: `@sentry/react`); keep each package on one family.",
  ]);
});

test("the Sentry CLI belongs to no SDK family", () => {
  const packages = [
    createPackage("@cup/cloudflare-worker", {
      "@cup/telemetry.cloudflare": "workspace:*",
      "@sentry/cloudflare": "catalog:sentry-server",
      "@sentry/cli": "catalog:sentry-client",
    }),
  ];

  expect(findSentrySdkFamilyProblems(packages)).toEqual([]);
});

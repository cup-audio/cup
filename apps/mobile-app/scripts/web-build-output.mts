/*
 * Empties the web app's served build, which `cap sync` packs into both native projects, and its
 * source maps, which `symbols:upload` sends to Sentry. Turbo restores a cached build by writing its
 * files over what a folder already holds and removes none, so without emptying these first a
 * release would pack, and upload the source maps of, every earlier build's files, as for the
 * Worker's deploy script. The declaration output and its build info stay, so TypeScript's
 * incremental build keeps working.
 */
import fs from "node:fs";
import path from "node:path";
import url from "node:url";

const WEB_APP_ROOT = path.dirname(
  url.fileURLToPath(import.meta.resolve("@cup/web-app/package.json")),
);

export function emptyWebBuildOutput(webAppRoot: string = WEB_APP_ROOT): void {
  for (const directory of ["web", "source-maps"]) {
    fs.rmSync(path.join(webAppRoot, "dist", directory), { recursive: true, force: true });
  }
}

if (import.meta.main) {
  emptyWebBuildOutput();
}

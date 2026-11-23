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

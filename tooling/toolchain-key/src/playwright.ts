import childProcess from "node:child_process";
import crypto from "node:crypto";
import fs from "node:fs";
import module from "node:module";
import path from "node:path";
import url from "node:url";
import util from "node:util";

import { readVersion, type Unreadable } from "#src/key-file.ts";

export type PlaywrightToolchainKey = {
  baseImageTag: string;
  serverImage: { tag: string; id: string | Unreadable };
};

const DOCKER_COMMAND_TIMEOUT_MS = 15_000;
const IMAGE_BUILD_TIMEOUT_MS = 300_000;

const execFile = util.promisify(childProcess.execFile);

export async function readPlaywrightToolchainKey(): Promise<PlaywrightToolchainKey> {
  const image = deriveImage();

  return {
    baseImageTag: `mcr.microsoft.com/playwright:v${image.playwrightVersion}-noble`,
    serverImage: { tag: image.tag, id: await readImageId(image) },
  };
}

type ServerImage = { playwrightVersion: string; directory: string; tag: string };

function deriveImage(): ServerImage {
  const configEntry = url.fileURLToPath(
    import.meta.resolve("@patricktree-stack/config-playwright/playwright-docker"),
  );
  const configDirectory = path.dirname(configEntry);

  const require = module.createRequire(configEntry);
  const playwrightPackageJson: unknown = require("@playwright/test/package.json");
  if (
    typeof playwrightPackageJson !== "object" ||
    playwrightPackageJson === null ||
    !("version" in playwrightPackageJson) ||
    typeof playwrightPackageJson.version !== "string"
  ) {
    throw new TypeError("@playwright/test/package.json must contain a string version");
  }
  const playwrightVersion = playwrightPackageJson.version;

  const imageDirectory = path.join(configDirectory, "playwright-server-image");
  const hash = crypto.createHash("sha256");
  for (const fileName of ["Dockerfile", "serve.sh"]) {
    hash.update(fs.readFileSync(path.join(imageDirectory, fileName)));
  }
  const imageFilesHash = hash.digest("hex").slice(0, 12);

  return {
    playwrightVersion,
    directory: imageDirectory,
    tag: `patricktree-stack/playwright-server:v${playwrightVersion}-${imageFilesHash}`,
  };
}

async function readImageId(image: ServerImage): Promise<string | Unreadable> {
  const inspectArgs = ["image", "inspect", "--format", "{{.Id}}", image.tag];
  return readVersion(`\`docker ${inspectArgs.join(" ")}\``, async () => {
    let id = await inspectImageId(inspectArgs);
    if (id === undefined) {
      await execFile(
        "docker",
        [
          "build",
          "--quiet",
          "--build-arg",
          `PLAYWRIGHT_VERSION=${image.playwrightVersion}`,
          "--tag",
          image.tag,
          image.directory,
        ],
        { timeout: IMAGE_BUILD_TIMEOUT_MS },
      );
      id = await inspectImageId(inspectArgs);
    }
    if (id === undefined || id === "") {
      throw new Error("printed no image ID");
    }
    return id;
  });
}

async function inspectImageId(inspectArgs: string[]): Promise<string | undefined> {
  try {
    const { stdout } = await execFile("docker", inspectArgs, {
      timeout: DOCKER_COMMAND_TIMEOUT_MS,
    });
    return stdout.trim();
  } catch (error) {
    if (isNoSuchImageError(error)) {
      return undefined;
    }
    throw error;
  }
}

function isNoSuchImageError(error: unknown): boolean {
  return (
    typeof error === "object" &&
    error !== null &&
    "stderr" in error &&
    /no such image/i.test(String(error.stderr))
  );
}

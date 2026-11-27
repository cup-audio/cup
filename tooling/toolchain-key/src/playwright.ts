import {
  buildPlaywrightServerImage,
  derivePlaywrightServerImage,
  type PlaywrightServerImage,
} from "@patricktree-stack/config-playwright/playwright-server-image";
import childProcess from "node:child_process";
import util from "node:util";

import { readVersion, type Unreadable } from "#src/key-file.ts";

export type PlaywrightToolchainKey = {
  baseImageTag: string;
  serverImage: { tag: string; id: string | Unreadable };
};

const DOCKER_COMMAND_TIMEOUT_MS = 15_000;

const execFile = util.promisify(childProcess.execFile);

export async function readPlaywrightToolchainKey(): Promise<PlaywrightToolchainKey> {
  const image = derivePlaywrightServerImage();

  return {
    baseImageTag: image.baseImageTag,
    serverImage: { tag: image.tag, id: await readImageId(image) },
  };
}

async function readImageId(image: PlaywrightServerImage): Promise<string | Unreadable> {
  const inspectArgs = ["image", "inspect", "--format", "{{.Id}}", image.tag];
  return readVersion(`\`docker ${inspectArgs.join(" ")}\``, async () => {
    let id = await inspectImageId(inspectArgs);
    if (id === undefined) {
      await buildPlaywrightServerImage(image);
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

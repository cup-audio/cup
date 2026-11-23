import path from "node:path";
import util from "node:util";

import { writeKeyFile } from "@cup/toolchain-key/key-file";

import { readAndroidToolchainKey } from "#src/android/toolchain-key.ts";
import { readIosToolchainKey } from "#src/ios/toolchain-key.ts";

const { values } = util.parseArgs({ options: { "output-dir": { type: "string" } } });
const outputDirectory = values["output-dir"];
if (outputDirectory === undefined) {
  throw new Error("Pass the directory to write the keys to as `--output-dir <directory>`.");
}

const [androidKey, iosKey] = await Promise.all([readAndroidToolchainKey(), readIosToolchainKey()]);
await writeKeyFile(path.join(outputDirectory, "android.json"), androidKey);
await writeKeyFile(path.join(outputDirectory, "ios.json"), iosKey);

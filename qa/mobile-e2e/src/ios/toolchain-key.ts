import { readVersion, type Unreadable } from "@cup/toolchain-key/key-file";

import { findIosRuntime, readXcodeVersion } from "#src/ios/preflight.ts";
import { readMacosVersion, type MacosVersion } from "#src/toolchain-version.ts";

export type IosToolchainKey = {
  xcode: { version: string; buildVersion: string } | Unreadable;
  simulatorRuntime: { identifier: string; version: string; buildVersion: string } | Unreadable;
  macos: MacosVersion | Unreadable;
};

export async function readIosToolchainKey(): Promise<IosToolchainKey> {
  const [xcode, simulatorRuntime, macos] = await Promise.all([
    readVersion("xcodebuild -version", readXcodeVersion),
    readVersion("xcrun simctl list runtimes", async () => {
      const { identifier, version, buildVersion } = await findIosRuntime();
      return { identifier, version, buildVersion };
    }),
    readMacosVersion(),
  ]);
  return { xcode, simulatorRuntime, macos };
}

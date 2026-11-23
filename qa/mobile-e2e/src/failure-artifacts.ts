import fs from "node:fs/promises";
import path from "node:path";

import type { MobilePlatform } from "#src/app-device.ts";

const PACKAGE_ROOT = path.resolve(import.meta.dirname, "..");
const OUTPUT_FOLDER = path.join(PACKAGE_ROOT, "test-output");
const CAPTURE_TIMEOUT_MS = 20_000;

export type FailureArtifact = {
  readonly fileName: string;
  readonly capture: () => Promise<string | Buffer>;
};

export async function clearFailureArtifacts(platform: MobilePlatform): Promise<void> {
  await fs.rm(path.join(OUTPUT_FOLDER, platform), { recursive: true, force: true });
}

export function failureArtifactFolder(options: {
  platform: MobilePlatform;
  specFile: string;
  testNames: readonly string[];
}): string {
  const spec = path.basename(options.specFile).replace(/\.test\.ts$/u, "");
  return path.join(OUTPUT_FOLDER, options.platform, spec, slugify(options.testNames.join(" ")));
}

export async function writeFailureArtifacts(
  folder: string,
  artifacts: readonly FailureArtifact[],
): Promise<void> {
  await fs.mkdir(folder, { recursive: true });
  for (const artifact of artifacts) {
    try {
      const content = await withTimeout(artifact.capture(), CAPTURE_TIMEOUT_MS);
      await fs.writeFile(path.join(folder, artifact.fileName), content);
    } catch (error) {
      await fs.writeFile(
        path.join(folder, `${artifact.fileName}.missing.txt`),
        `Could not capture ${artifact.fileName}:\n${error instanceof Error ? (error.stack ?? error.message) : String(error)}\n`,
      );
    }
  }
}

export function appiumFailureArtifacts(options: {
  driver: WebdriverIO.Browser;
  findWebViewContext: () => Promise<string | undefined>;
  readDeviceLog: () => Promise<string>;
}): FailureArtifact[] {
  const { driver } = options;
  let sessionUnresponsive = false;
  const throughSession =
    (capture: () => Promise<string | Buffer>) => async (): Promise<string | Buffer> => {
      if (sessionUnresponsive) {
        throw new Error("Skipped: the Appium session left an earlier capture unanswered.");
      }
      try {
        return await withTimeout(capture(), CAPTURE_TIMEOUT_MS);
      } catch (error) {
        sessionUnresponsive ||= error instanceof CaptureTimeoutError;
        throw error;
      }
    };
  let testContext: Promise<string> | undefined;
  const switchToNative = async (): Promise<string> => {
    testContext ??= driver
      .getAppiumContext()
      .then((context) => (typeof context === "string" ? context : context.id));
    const context = await testContext;
    await driver.switchContext("NATIVE_APP");
    return context;
  };
  return [
    { fileName: "device.log", capture: options.readDeviceLog },
    {
      fileName: "screenshot.png",
      capture: throughSession(async () => {
        await switchToNative();
        return Buffer.from(await driver.takeScreenshot(), "base64");
      }),
    },
    {
      fileName: "native-page-source.xml",
      capture: throughSession(async () => {
        await switchToNative();
        return driver.getPageSource();
      }),
    },
    {
      fileName: "webview-dom.html",
      capture: throughSession(async () => {
        const context = await switchToNative();
        const webViewContext = context.startsWith("WEBVIEW_")
          ? context
          : await options.findWebViewContext();
        if (webViewContext === undefined) {
          throw new Error("Cup shows no WebView to read.");
        }
        await driver.switchContext(webViewContext);
        return driver.getPageSource();
      }),
    },
  ];
}

class CaptureTimeoutError extends Error {}

async function withTimeout<T>(promise: Promise<T>, timeoutMs: number): Promise<T> {
  let timeout: NodeJS.Timeout | undefined;
  try {
    return await Promise.race([
      promise,
      new Promise<never>((_resolve, reject) => {
        timeout = setTimeout(
          () => reject(new CaptureTimeoutError(`Timed out after ${timeoutMs} ms.`)),
          timeoutMs,
        );
      }),
    ]);
  } finally {
    clearTimeout(timeout);
  }
}

function slugify(name: string): string {
  return name
    .toLowerCase()
    .replaceAll(/[^a-z0-9]+/gu, "-")
    .replaceAll(/^-|-$/gu, "")
    .slice(0, 120);
}

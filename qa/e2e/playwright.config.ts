import { createPlaywrightDockerConfig } from "@patricktree-stack/config-playwright/playwright-docker";
import { defineConfig, devices } from "@playwright/test";
import path from "node:path";

import { REQUEST_ONLY_TAG, VISUAL_TAG } from "#test-e2e/browser-project-tags.ts";

const outputRoot = "./playwright-output";
const dockerConfig = createPlaywrightDockerConfig({ maxWorkers: 8 });
const VISUAL_TESTS_ONLY = new RegExp(VISUAL_TAG);
const REQUEST_ONLY_TESTS = new RegExp(REQUEST_ONLY_TAG);

export default defineConfig(dockerConfig, {
  testDir: "./test-e2e",
  globalSetup: [
    ...(dockerConfig.globalSetup === undefined ? [] : [dockerConfig.globalSetup].flat()),
    "./test-e2e/https-certificate.global-setup.ts",
  ],
  expect: {
    toHaveScreenshot: { maxDiffPixelRatio: 0 },
  },
  outputDir: path.join(outputRoot, "test-results"),
  reporter: [["html", { open: "never", outputFolder: path.join(outputRoot, "html-report") }]],
  projects: [
    {
      name: "mobile-chromium",
      grep: VISUAL_TESTS_ONLY,
      use: {
        ...devices["Pixel 9 Pro"],
      },
    },
    {
      name: "desktop-chromium",
      use: {
        ...devices["Desktop Chrome"],
      },
    },
    {
      name: "mobile-webkit",
      grepInvert: REQUEST_ONLY_TESTS,
      use: {
        ...devices["iPhone 15 Pro"],
      },
    },
    {
      name: "desktop-webkit",
      grep: VISUAL_TESTS_ONLY,
      use: {
        ...devices["Desktop Safari"],
      },
    },
  ],
  use: {
    ignoreHTTPSErrors: true,
    locale: "en-US",
    timezoneId: "Europe/Vienna",
    colorScheme: "light",
    trace: "retain-on-failure",
    screenshot: "only-on-failure",
  },
});

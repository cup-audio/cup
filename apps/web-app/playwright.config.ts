import { createPlaywrightDockerConfig } from "@patricktree-stack/config-playwright/playwright-docker";
import { defineConfig, devices } from "@playwright/test";
import path from "node:path";

import { VISUAL_TAG } from "#src/test-utils/component-test.ts";

const outputRoot = "./playwright-output";
// oxlint-disable-next-line node/no-process-env -- The shared Docker configuration uses CI to select its safeguards.
const isCI = Boolean(process.env["CI"]);
// oxlint-disable-next-line node/no-process-env -- Playwright publishes the gallery port captured by webServer.wait.stdout to workers through the environment.
const galleryPort = process.env["CUP_UI_GALLERY_PORT"] ?? "";
const dockerConfig = createPlaywrightDockerConfig({ isCI, maxWorkers: 8 });
const VISUAL_TESTS_ONLY = new RegExp(VISUAL_TAG);

export default defineConfig({
  ...dockerConfig,
  expect: {
    toHaveScreenshot: { maxDiffPixelRatio: 0 },
  },
  outputDir: path.join(outputRoot, "test-results"),
  reporter: [["html", { open: "never", outputFolder: path.join(outputRoot, "html-report") }]],
  testDir: "./src",
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
    ...dockerConfig.use,
    ...(dockerConfig.use?.connectOptions && {
      connectOptions: {
        ...dockerConfig.use.connectOptions,
        exposeNetwork: "<loopback>",
      },
    }),
    baseURL: `http://127.0.0.1:${galleryPort}/ui-gallery/index.html?canvas=1`,
    serviceWorkers: "allow",
    colorScheme: "light",
    locale: "en-US",
    screenshot: "only-on-failure",
    timezoneId: "Europe/Vienna",
    trace: "retain-on-failure",
  },
  webServer: [
    {
      command: "pnpm run build:gallery && pnpm run preview:gallery --port 0",
      env: { NODE_ENV: "development" },
      wait: { stdout: /Local:\s+http:\/\/127\.0\.0\.1:(?<CUP_UI_GALLERY_PORT>\d+)\// },
      timeout: 60_000,
    },
  ],
});

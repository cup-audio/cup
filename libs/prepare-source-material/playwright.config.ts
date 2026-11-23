import { createPlaywrightDockerConfig } from "@patricktree-stack/config-playwright/playwright-docker";
import { defineConfig } from "@playwright/test";

const dockerConfig = createPlaywrightDockerConfig({ maxWorkers: 2 });
// oxlint-disable-next-line node/no-process-env -- Playwright publishes the source-page server port captured by webServer.wait.stdout to workers through the environment.
const sourcePageServerPort = process.env["CUP_SOURCE_PAGE_SERVER_PORT"] ?? "";

export default defineConfig({
  ...dockerConfig,
  testDir: "./test-e2e",
  timeout: 120_000,
  outputDir: "./playwright-output/test-results",
  reporter: [["html", { open: "never", outputFolder: "./playwright-output/html-report" }]],
  snapshotPathTemplate: "{testDir}/{arg}{ext}",
  webServer: [
    {
      command: "node test-e2e/source-page-server.ts",
      wait: { stdout: /Listening on http:\/\/127\.0\.0\.1:(?<CUP_SOURCE_PAGE_SERVER_PORT>\d+)/ },
      gracefulShutdown: { signal: "SIGTERM", timeout: 5_000 },
    },
  ],
  use: {
    ...dockerConfig.use,
    baseURL: `http://127.0.0.1:${sourcePageServerPort}`,
    browserName: "chromium",
    trace: "retain-on-failure",
  },
});

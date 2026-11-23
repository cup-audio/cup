import { defineConfig, devices } from "@playwright/test";

import componentTestConfig from "#playwright.config.ts";

export default defineConfig({
  ...componentTestConfig,
  testDir: "./fidelity-check",
  testMatch: "run.ts",
  reporter: "line",
  projects: [{ name: "fidelity-check", use: { ...devices["Desktop Chrome"] } }],
});

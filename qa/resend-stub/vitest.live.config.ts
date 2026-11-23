import { config as baseConfig } from "@patricktree-stack/config-vitest/vitest-base.js";
import { defineConfig, mergeConfig } from "vitest/config";

export default mergeConfig(
  baseConfig,
  defineConfig({
    test: {
      include: ["test-live/**/*.test.ts"],
      retry: 0,
      testTimeout: 30_000,
    },
  }),
);

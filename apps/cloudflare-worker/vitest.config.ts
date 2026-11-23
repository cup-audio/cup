import { config as baseConfig } from "@patricktree-stack/config-vitest/vitest-base.js";
import { defineConfig, mergeConfig } from "vitest/config";

export default mergeConfig(
  baseConfig,
  defineConfig({
    test: {
      sequence: { concurrent: true },
      retry: 0,
      testTimeout: 30_000,
    },
  }),
);

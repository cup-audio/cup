import { config as baseConfig } from "@patricktree-stack/config-vitest/vitest-base.js";
import { defineConfig, mergeConfig } from "vitest/config";

export default mergeConfig(
  baseConfig,
  defineConfig({
    test: {
      include: ["scripts/**/*.test.mts"],
      coverage: {
        include: ["scripts/**/*.mts"],
        exclude: ["scripts/**/*.test.mts"],
      },
    },
  }),
);

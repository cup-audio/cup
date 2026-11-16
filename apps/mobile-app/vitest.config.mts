import { config as baseConfig } from "@patricktree-stack/config-vitest/vitest-base.js";
import { defineConfig, mergeConfig } from "vitest/config";

export default mergeConfig(
  baseConfig,
  defineConfig({
    test: {
      include: ["scripts/**/*.test.mts"],
      // The package's code lives in `scripts/`, not in the `src/` the shared configuration covers.
      coverage: {
        include: ["scripts/**/*.mts"],
        exclude: ["scripts/**/*.test.mts"],
      },
    },
  }),
);

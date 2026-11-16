import { config as baseConfig } from "@patricktree-stack/config-vitest/vitest-base.js";
import { defineConfig, mergeConfig } from "vitest/config";

export default mergeConfig(
  baseConfig,
  defineConfig({
    test: {
      /*
       * Many tests run a whole conversion against Durable Objects in a Wrangler test harness, which
       * outlasted Vitest's 5 s default under a full parallel test run, though each passes alone.
       */
      testTimeout: 20_000,
      coverage: {
        thresholds: {
          branches: 54.54,
          functions: 12.5,
          lines: 17.39,
          statements: 17.39,
        },
      },
    },
  }),
);

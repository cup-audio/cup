import { config as baseConfig } from "@patricktree-stack/config-vitest/vitest-base.js";
import { defineConfig, mergeConfig } from "vitest/config";

export default mergeConfig(
  baseConfig,
  defineConfig({
    test: {
      /*
       * Each test drives Durable Objects in a Wrangler test harness through many RPC round trips,
       * which outlasted Vitest's 5 s default under a full parallel test run, though each passes
       * alone in well under a second.
       */
      testTimeout: 20_000,
    },
  }),
);

import { config as baseConfig } from "@patricktree-stack/config-vitest/vitest-base.js";
import { fileURLToPath } from "node:url";
import { defineConfig, mergeConfig } from "vitest/config";

export default mergeConfig(
  baseConfig,
  defineConfig({
    resolve: {
      alias: {
        "cloudflare:workers": fileURLToPath(
          new URL("test/cloudflare-workers-stub.ts", import.meta.url),
        ),
      },
    },
  }),
);

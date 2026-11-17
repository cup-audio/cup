import { defineConfig, mergeConfig } from "vite";

import { createWebAppViteConfig } from "@cup/web-app/vite";

export default mergeConfig(
  createWebAppViteConfig(),
  defineConfig({
    // `prepare-source-maps` in `turbo:build` moves the maps out of what is served and packed.
    build: { outDir: "dist/web", sourcemap: "hidden" },
  }),
);

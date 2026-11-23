import type { KnipConfig } from "knip";

const config: KnipConfig = {
  $schema: "./node_modules/knip/schema.json",
  ignore: [".patricktree-stack/**"],
  workspaces: {
    ".": {
      ignoreBinaries: ["uvx"],
      ignoreDependencies: ["husky", "@emnapi/core", "@emnapi/runtime", "cf"],
    },
    "apps/cloudflare-worker": {
      entry: ["test/worker.ts"],
    },
    "libs/create-audiobook-from-url-workflow": {
      entry: ["test/worker.ts"],
    },
    "apps/web-app": {
      entry: ["src/**/*.story.tsx", "playwright.fidelity-check.config.ts", "fidelity-check/run.ts"],
    },
    "libs/registry": {
      entry: ["test/worker.ts"],
    },
    "libs/accounts": {
      entry: ["test/worker.ts"],
    },
    "libs/conversion-grants": {
      entry: ["test/worker.ts"],
    },
    "qa/e2e": {
      ignoreBinaries: ["openssl"],
    },
    "qa/test-worker": {
      ignoreDependencies: ["@cup/cloudflare-worker"],
    },
    "libs/narration-source-analysis": {
      entry: ["vitest.evals.config.ts", "test/evals/**/*.eval.ts"],
    },
  },
};

export default config;

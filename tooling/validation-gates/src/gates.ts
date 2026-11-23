import process from "node:process";
import { z } from "zod";

import { findTrackedChanges, runGit } from "#src/git.ts";
import { runCommand, runCommandOrThrow } from "#src/run-command.ts";

type Prerequisite = {
  name: string;
  findProblem: () => Promise<string | undefined>;
};

type Step = {
  name: string;
  command: [string, ...string[]];
  findSkipReason?: () => Promise<string | undefined>;
  isReplayMarked?: boolean;
};

export type Gate = {
  name: string;
  prerequisites: Prerequisite[];
  steps: Step[];
};

const NARRATION_SOURCE_ANALYSIS = "@cup/narration-source-analysis";
const AFFECTED_BASE = "origin/main";
const TURBO_LS_OUTPUT = z.object({
  packages: z.object({ items: z.array(z.object({ name: z.string() })) }),
});

const DOCKER_RUNNING = commandPrerequisite(
  "Docker running",
  ["docker", "info"],
  "Docker is not running (`docker info` failed); start Docker Desktop.",
);
const UVX_INSTALLED = commandPrerequisite(
  "uvx installed",
  ["uvx", "--version"],
  "`uvx` is not installed (`uvx --version` failed); zizmor runs through it.",
);
const GH_AUTHENTICATED = commandPrerequisite(
  "GitHub CLI authenticated",
  ["gh", "auth", "status"],
  "GitHub CLI is not authenticated (`gh auth status` failed); zizmor needs its token. Run `gh auth login`.",
);

const ANDROID_JVM_TOOLCHAIN_READY = commandPrerequisite(
  "JDK 21 and Android SDK",
  ["pnpm", "--silent", "--filter", "@cup/mobile-app", "run", "jvm:check"],
  "The Android app's JVM unit test toolchain is missing",
  { isOutputShown: true },
);

const CHECKOUT_DEPLOYABLE: Prerequisite = {
  name: "Checkout at `origin/main`",
  findProblem: async () => {
    await runGit(["fetch", "origin"]);

    const branchName = (await runGit(["branch", "--show-current"])).trim();
    if (branchName !== "main") {
      const actual = branchName === "" ? "a detached `HEAD`" : `branch \`${branchName}\``;
      return `The checkout is on ${actual}, not \`main\`; the deploy gate runs only on \`main\`.`;
    }

    const head = (await runGit(["rev-parse", "HEAD"])).trim();
    const originMain = (await runGit(["rev-parse", "refs/remotes/origin/main"])).trim();
    if (head !== originMain) {
      return `\`HEAD\` (${head.slice(0, 8)}) differs from the freshly fetched \`origin/main\` (${originMain.slice(0, 8)}); the deploy gate runs only on exactly \`origin/main\`.`;
    }

    const changes = await findTrackedChanges();
    if (changes !== "") {
      return `Tracked files have uncommitted changes; the deploy gate runs only on a clean checkout:\n\n\`\`\`\n${changes}\n\`\`\``;
    }
    return undefined;
  },
};

const MOBILE_TOOLCHAINS_READY = commandPrerequisite(
  "Mobile toolchains ready",
  ["pnpm", "--silent", "--filter", "@cup/mobile-e2e", "run", "preflight"],
  "The mobile E2E suite's preflight check failed",
  { isOutputShown: true },
);

const REVIEW_GATE: Gate = {
  name: "review",
  prerequisites: [DOCKER_RUNNING, UVX_INSTALLED, GH_AUTHENTICATED, ANDROID_JVM_TOOLCHAIN_READY],
  steps: [
    { name: "Env check", command: ["pnpm", "run", "env:check"] },
    { name: "Submodule check", command: ["pnpm", "run", "submodule:check"] },
    { name: "Format check", command: ["pnpm", "run", "format:check"] },
    { name: "Docs check", command: ["pnpm", "run", "docs:check"] },
    { name: "Comment check", command: ["pnpm", "run", "comments:check"] },
    { name: "Turbo boundaries", command: ["pnpm", "run", "boundaries"] },
    { name: "Build", command: turboRun("turbo:build") },
    { name: "Lint", command: turboRun("turbo:lint") },
    { name: "Test", command: turboRun("turbo:test") },
    { name: "Knip", command: ["pnpm", "run", "declutter"] },
    { name: "Brand-assets check", command: ["pnpm", "run", "brand-assets:check"] },
    { name: "Zizmor", command: ["pnpm", "run", "zizmor"] },
    {
      name: "Source-material E2E",
      command: ["pnpm", "run", "test:e2e:source-material"],
      isReplayMarked: true,
    },
    {
      name: "Narration evals",
      command: ["pnpm", "run", "evals"],
      findSkipReason: async () =>
        (await findAffectedPackages()).includes(NARRATION_SOURCE_ANALYSIS)
          ? undefined
          : `\`${NARRATION_SOURCE_ANALYSIS}\` and its dependencies are not affected relative to \`${AFFECTED_BASE}\``,
    },
  ],
};

const MERGE_GATE: Gate = {
  name: "merge",
  prerequisites: [...REVIEW_GATE.prerequisites],
  steps: [
    ...REVIEW_GATE.steps,
    { name: "App E2E", command: ["pnpm", "run", "test:e2e:app"], isReplayMarked: true },
  ],
};

const DEPLOY_GATE: Gate = {
  name: "deploy",
  prerequisites: [CHECKOUT_DEPLOYABLE, ...MERGE_GATE.prerequisites, MOBILE_TOOLCHAINS_READY],
  steps: [
    ...MERGE_GATE.steps,
    { name: "Mobile E2E", command: ["pnpm", "run", "test:e2e:mobile"], isReplayMarked: true },
  ],
};

export const GATE_NAMES = ["review", "merge", "deploy"] as const;

export type GateName = (typeof GATE_NAMES)[number];

export const GATES: Record<GateName, Gate> = {
  review: REVIEW_GATE,
  merge: MERGE_GATE,
  deploy: DEPLOY_GATE,
};

function commandPrerequisite(
  name: string,
  command: [string, ...string[]],
  message: string,
  { isOutputShown = false }: { isOutputShown?: boolean } = {},
): Prerequisite {
  return {
    name,
    findProblem: async () => {
      const result = await runCommand(command);
      if (result.exitCode === 0) {
        return undefined;
      }
      return isOutputShown ? `${message}:\n\n${result.output.trim()}` : message;
    },
  };
}

function turboRun(task: string): [string, ...string[]] {
  return ["pnpm", "exec", "turbo", "run", task, "--output-logs=errors-only"];
}

async function findAffectedPackages(): Promise<string[]> {
  const stdout = await runCommandOrThrow(
    ["pnpm", "exec", "turbo", "ls", "--affected", "--output=json"],
    { env: { ...process.env, TURBO_SCM_BASE: AFFECTED_BASE } },
  );
  const listing = TURBO_LS_OUTPUT.parse(JSON.parse(stdout));
  return listing.packages.items.map((item) => item.name);
}

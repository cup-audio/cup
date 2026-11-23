import { Command, CommanderError, InvalidArgumentError } from "@commander-js/extra-typings";
import { spawn } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

import {
  parseWholePixels,
  toFidelityCheckEnvironment,
  type FidelityCheckInputs,
} from "#fidelity-check/inputs.ts";

import { readDesignImageSize } from "@cup/fidelity-check";

type CliDependencies = {
  workingDirectory: string;
  launch: (inputs: FidelityCheckInputs, playwrightArgs: string[]) => Promise<number>;
  output: { log: (message: string) => void; error: (message: string) => void };
};

const PACKAGE_DIRECTORY = path.resolve(import.meta.dirname, "..");
const SCRIPT_NAME = "fidelity-check";
const SIGNAL_EXIT_CODE_BASE = 128;

export async function runFidelityCheckCli(
  args: string[],
  { workingDirectory, launch, output }: CliDependencies,
): Promise<number> {
  const program = new Command()
    .name("fidelity-check")
    .description("Compare a story with the design's image")
    .usage("--story <story> --image <path> [--ignore-top <pixels>] [-- <playwright options>]")
    .requiredOption("--story <story>", "the story to render, such as routes/index/LandingPage")
    .requiredOption("--image <path>", "the design's render as a PNG at 1x", (image) =>
      parseDesignImage(path.resolve(workingDirectory, image)),
    )
    .option(
      "--ignore-top <pixels>",
      "rows the app does not draw, such as a device status bar",
      (pixels) => toCommanderArgument(() => parseWholePixels(pixels)),
      0,
    )
    .argument("[playwright-options...]", "options for Playwright, after --, such as --headed")
    .showHelpAfterError()
    .exitOverride()
    .configureOutput({
      writeOut: (message) => output.log(message),
      writeErr: (message) => output.error(message),
    });

  try {
    program.parse(args, { from: "user" });
  } catch (error) {
    if (error instanceof CommanderError) {
      return error.exitCode;
    }
    throw error;
  }

  const { story, image, ignoreTop } = program.opts();
  return launch({ story, designImagePath: image, ignoreTopPixels: ignoreTop }, program.args);
}

export function findWorkingDirectory(
  environment: Record<string, string | undefined>,
  currentDirectory: string,
): string {
  const initialDirectory = environment["INIT_CWD"];
  return environment["npm_lifecycle_event"] === SCRIPT_NAME && initialDirectory !== undefined
    ? initialDirectory
    : currentDirectory;
}

function parseDesignImage(designImagePath: string): string {
  return toCommanderArgument(() => {
    if (!fs.existsSync(designImagePath)) {
      throw new Error(`The design image does not exist: ${designImagePath}`);
    }
    if (!fs.statSync(designImagePath).isFile()) {
      throw new Error(`The design image is no file: ${designImagePath}`);
    }
    readDesignImageSize(designImagePath);
    return designImagePath;
  });
}

function toCommanderArgument<T>(parse: () => T): T {
  try {
    return parse();
  } catch (error) {
    throw new InvalidArgumentError(error instanceof Error ? error.message : String(error));
  }
}

function launchPlaywright(inputs: FidelityCheckInputs, playwrightArgs: string[]): Promise<number> {
  const playwrightCli = fileURLToPath(import.meta.resolve("@playwright/test/cli"));
  const child = spawn(
    process.execPath,
    [playwrightCli, "test", "--config", "playwright.fidelity-check.config.ts", ...playwrightArgs],
    {
      cwd: PACKAGE_DIRECTORY,
      stdio: "inherit",
      // oxlint-disable-next-line node/no-process-env -- Playwright and Docker need the caller's environment.
      env: { ...process.env, ...toFidelityCheckEnvironment(inputs) },
    },
  );

  const forwardSignal = (signal: NodeJS.Signals) => child.kill(signal);
  process.on("SIGINT", forwardSignal);
  process.on("SIGTERM", forwardSignal);

  return new Promise((resolve, reject) => {
    child.on("error", reject);
    child.on("exit", (code, signal) => {
      process.off("SIGINT", forwardSignal);
      process.off("SIGTERM", forwardSignal);
      resolve(code ?? SIGNAL_EXIT_CODE_BASE + (signal === null ? 0 : os.constants.signals[signal]));
    });
  });
}

if (import.meta.main) {
  process.exitCode = await runFidelityCheckCli(process.argv.slice(2), {
    // oxlint-disable-next-line node/no-process-env -- The one way to learn where the command was typed.
    workingDirectory: findWorkingDirectory(process.env, process.cwd()),
    launch: launchPlaywright,
    output: console,
  });
}

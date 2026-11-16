#!/usr/bin/env node
import { Command, CommanderError } from "@commander-js/extra-typings";

import { prepareSourceMaps } from "#src/prepare-source-maps.ts";

export async function runCli(
  args: string[],
  output: Pick<Console, "log" | "error"> = console,
): Promise<number> {
  const program = new Command()
    .name("prepare-source-maps")
    .description("Inject Sentry debug IDs into a build output and move its source maps out of it")
    .showHelpAfterError()
    .exitOverride()
    .configureOutput({
      writeOut: (message) => output.log(message),
      writeErr: (message) => output.error(message),
    })
    .requiredOption("--build-dir <directory>", "build output that is served, deployed or packed")
    .requiredOption("--source-map-dir <directory>", "directory that receives the source maps")
    .action(async (options) => prepareSourceMaps(options, output));

  try {
    await program.parseAsync(args, { from: "user" });
    return 0;
  } catch (error) {
    if (error instanceof CommanderError) {
      return error.exitCode;
    }
    output.error(error instanceof Error ? error.message : "Source map preparation failed.");
    return 1;
  }
}

if (import.meta.main) {
  process.exitCode = await runCli(process.argv.slice(2));
}

#!/usr/bin/env node
import { Argument, Command, CommanderError } from "@commander-js/extra-typings";

import {
  spawnSentryCli,
  uploadShellSymbols,
  type RunSentryCli,
} from "#src/upload-shell-symbols.ts";

export async function runCli(
  args: string[],
  runSentryCli: RunSentryCli = spawnSentryCli,
  output: Pick<Console, "log" | "error"> = console,
): Promise<number> {
  const program = new Command()
    .name("upload-shell-symbols")
    .description(
      "Upload a shell release's dSYMs and the source maps of its packed web bundle to Sentry",
    )
    .showHelpAfterError()
    .exitOverride()
    .configureOutput({
      writeOut: (message) => output.log(message),
      writeErr: (message) => output.error(message),
    })
    .addArgument(new Argument("<platform>", "the shell").choices(["ios", "android"] as const))
    .argument("[archive]", "the .xcarchive of the iOS release")
    .requiredOption("--web-source-map-dir <directory>", "the web build's source maps")
    .requiredOption(
      "--android-web-dir <directory>",
      "the web bundle packed into the Android project",
    )
    .action(async (platform, archive, options) => {
      if (platform === "ios") {
        if (archive === undefined) {
          throw new Error("Pass the path of the release's .xcarchive after `ios`.");
        }
        await uploadShellSymbols(
          { platform, archive, webSourceMapDir: options.webSourceMapDir },
          runSentryCli,
        );
      } else {
        if (archive !== undefined) {
          throw new Error("An Android release has no archive to pass; pass `android` alone.");
        }
        await uploadShellSymbols(
          {
            platform,
            packedWebDir: options.androidWebDir,
            webSourceMapDir: options.webSourceMapDir,
          },
          runSentryCli,
        );
      }
      output.log(`Uploaded the ${platform} release's symbols to Sentry.`);
    });

  try {
    await program.parseAsync(args, { from: "user" });
    return 0;
  } catch (error) {
    if (error instanceof CommanderError) {
      return error.exitCode;
    }
    output.error(error instanceof Error ? error.message : "Uploading the symbols failed.");
    return 1;
  }
}

if (import.meta.main) {
  process.exitCode = await runCli(process.argv.slice(2));
}

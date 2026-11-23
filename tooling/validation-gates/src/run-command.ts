import childProcess from "node:child_process";
import path from "node:path";
import process from "node:process";

export type CommandResult = {
  exitCode: number;
  stdout: string;
  output: string;
};

const REPOSITORY_ROOT = path.resolve(import.meta.dirname, "../../..");

export function runCommand(
  command: [string, ...string[]],
  {
    env = process.env,
    output: outputMode = "captured",
  }: { env?: NodeJS.ProcessEnv; output?: "captured" | "streamed" | "teed" } = {},
): Promise<CommandResult> {
  const [executable, ...args] = command;

  return new Promise((resolve) => {
    let stdout = "";
    let output = "";
    const child = childProcess.spawn(executable, args, {
      cwd: REPOSITORY_ROOT,
      env,
      stdio: outputMode === "streamed" ? "inherit" : ["ignore", "pipe", "pipe"],
    });

    child.stdout?.on("data", (chunk: Buffer) => {
      stdout += chunk.toString();
      output += chunk.toString();
      if (outputMode === "teed") {
        process.stdout.write(chunk);
      }
    });
    child.stderr?.on("data", (chunk: Buffer) => {
      output += chunk.toString();
      if (outputMode === "teed") {
        process.stderr.write(chunk);
      }
    });

    child.on("error", (error) => {
      resolve({ exitCode: 127, stdout, output: output + error.message });
    });
    child.on("close", (exitCode, signal) => {
      resolve({ exitCode: exitCode ?? (signal === null ? 1 : 128), stdout, output });
    });
  });
}

export async function runCommandOrThrow(
  command: [string, ...string[]],
  options: { env?: NodeJS.ProcessEnv } = {},
): Promise<string> {
  const result = await runCommand(command, options);
  if (result.exitCode !== 0) {
    throw new Error(
      `\`${command.join(" ")}\` failed with exit code ${result.exitCode}:\n${result.output.trim()}`,
    );
  }
  return result.stdout;
}

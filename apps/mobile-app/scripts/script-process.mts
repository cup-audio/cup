import childProcess from "node:child_process";
import path from "node:path";

export const MOBILE_APP_ROOT = path.resolve(import.meta.dirname, "..");

export function fail(message: string): never {
  console.error(message);
  process.exit(1);
}

export function runVisible(
  command: string,
  args: readonly string[],
  { cwd, env }: { cwd: string; env: NodeJS.ProcessEnv },
): void {
  const result = childProcess.spawnSync(command, args, { cwd, env, stdio: "inherit" });
  if (result.error !== undefined || result.status !== 0) {
    fail(`\`${formatCommand(command, args)}\` ${describeFailure(result)}.`);
  }
}

export function runCaptured(
  command: string,
  args: readonly string[],
  { env = process.env, failureHint }: { env?: NodeJS.ProcessEnv; failureHint?: string } = {},
): string {
  const result = childProcess.spawnSync(command, args, {
    cwd: MOBILE_APP_ROOT,
    env,
    encoding: "utf8",
  });
  if (result.error !== undefined || result.status !== 0) {
    fail(
      `\`${formatCommand(command, args)}\` ${describeFailure(result)}.${failureHint === undefined ? "" : ` ${failureHint}`}\n${result.stdout}${result.stderr}`,
    );
  }

  return result.stdout;
}

function formatCommand(command: string, args: readonly string[]): string {
  return [command, ...args].join(" ");
}

function describeFailure(result: childProcess.SpawnSyncReturns<unknown>): string {
  return result.error === undefined
    ? `exited with ${String(result.status)}`
    : `failed: ${result.error.message}`;
}

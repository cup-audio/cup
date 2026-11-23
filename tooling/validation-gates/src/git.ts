import { runCommandOrThrow } from "#src/run-command.ts";

export function runGit(args: string[]): Promise<string> {
  return runCommandOrThrow(["git", ...args]);
}

export async function findTrackedChanges(): Promise<string> {
  return (await runGit(["status", "--porcelain", "--untracked-files=no"])).trimEnd();
}

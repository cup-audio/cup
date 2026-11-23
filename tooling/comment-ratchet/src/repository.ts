import childProcess from "node:child_process";
import fs from "node:fs/promises";
import path from "node:path";
import url from "node:url";
import { promisify } from "node:util";

import { isScannable, scanComments, type ScannedComment } from "#src/comment-scan.ts";

const execFile = promisify(childProcess.execFile);

export const REPOSITORY_ROOT = url.fileURLToPath(new URL("../../..", import.meta.url));

export async function scanRepository(
  root: string = REPOSITORY_ROOT,
): Promise<Map<string, ScannedComment[]>> {
  const files = await listScannableFiles(root);
  const entries = await Promise.all(
    files.map(async (file) => {
      const text = await fs.readFile(path.join(root, file), "utf8");
      return [file, scanComments(file, text)] as const;
    }),
  );
  return new Map(entries.filter(([, comments]) => comments.length > 0));
}

async function listScannableFiles(root: string): Promise<string[]> {
  const tracked = await git(root, ["ls-files", "-z", "--cached", "--others", "--exclude-standard"]);
  const candidates = splitNul(tracked).filter(isScannable);
  const generated = await findGeneratedFiles(root, candidates);
  const existing = await Promise.all(
    candidates.map(async (file) =>
      (await isRegularFile(path.join(root, file))) ? file : undefined,
    ),
  );
  return existing.filter((file): file is string => file !== undefined && !generated.has(file));
}

async function findGeneratedFiles(root: string, files: string[]): Promise<Set<string>> {
  const child = childProcess.spawn("git", ["check-attr", "-z", "--stdin", "linguist-generated"], {
    cwd: root,
  });
  const output: Buffer[] = [];
  child.stdout.on("data", (chunk: Buffer) => output.push(chunk));
  child.stdin.end(files.map((file) => `${file}\0`).join(""));
  await new Promise<void>((resolve, reject) => {
    child.on("error", reject);
    child.on("close", (code) =>
      code === 0 ? resolve() : reject(new Error(`git check-attr exited with ${code}`)),
    );
  });
  const fields = splitNul(Buffer.concat(output).toString("utf8"));
  const generated = new Set<string>();
  for (let index = 0; index + 2 < fields.length; index += 3) {
    if (fields[index + 2] === "true") {
      generated.add(fields[index] ?? "");
    }
  }
  return generated;
}

async function isRegularFile(file: string): Promise<boolean> {
  const stats = await fs.lstat(file).catch(() => undefined);
  return stats?.isFile() ?? false;
}

async function git(root: string, args: string[]): Promise<string> {
  const { stdout } = await execFile("git", args, { cwd: root, maxBuffer: 64 * 1024 * 1024 });
  return stdout;
}

function splitNul(text: string): string[] {
  return text.split("\0").filter((field) => field.length > 0);
}

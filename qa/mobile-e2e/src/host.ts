import childProcess from "node:child_process";
import { once } from "node:events";
import fs from "node:fs/promises";
import net from "node:net";
import path from "node:path";
import { Temporal } from "temporal-polyfill";

export type CommandResult = {
  readonly exitCode: number;
  readonly stdout: string;
  readonly stderr: string;
};

type RunOptions = {
  cwd?: string;
  env?: NodeJS.ProcessEnv;
  successExitCodes?: readonly number[];
};

const TAKEOVER_ABANDONED_AFTER_MS = 10_000;

export async function run(
  command: string,
  args: readonly string[],
  options: RunOptions = {},
): Promise<CommandResult> {
  const child = childProcess.spawn(command, args, {
    cwd: options.cwd,
    env: options.env ?? process.env,
    stdio: ["ignore", "pipe", "pipe"],
  });
  let stdout = "";
  let stderr = "";
  child.stdout.setEncoding("utf8").on("data", (chunk: string) => (stdout += chunk));
  child.stderr.setEncoding("utf8").on("data", (chunk: string) => (stderr += chunk));

  const exitCode = await new Promise<number | null>((resolve, reject) => {
    child.on("error", reject);
    child.on("close", resolve);
  });
  if (exitCode === null || !(options.successExitCodes ?? [0]).includes(exitCode)) {
    throw new Error(
      `\`${[command, ...args].join(" ")}\` exited with ${String(exitCode)}.\n${stdout}${stderr}`,
    );
  }
  return { exitCode, stdout, stderr };
}

export async function reservePort(): Promise<number> {
  const server = net.createServer();
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  if (address === null || typeof address === "string") {
    throw new Error("The operating system assigned no port.");
  }
  const { port } = address;
  await new Promise<void>((resolve, reject) =>
    server.close((error) => (error === undefined ? resolve() : reject(error))),
  );
  return port;
}

export async function waitFor<T>(
  description: string,
  check: () => Promise<T | undefined>,
  timeoutMs: number,
): Promise<T> {
  const deadline = performance.now() + timeoutMs;
  for (;;) {
    const value = await check();
    if (value !== undefined) {
      return value;
    }
    if (performance.now() > deadline) {
      throw new Error(`Timed out after ${timeoutMs} ms waiting for ${description}.`);
    }
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
}

export async function stopChild(child: childProcess.ChildProcess, graceMs = 10_000): Promise<void> {
  if (child.exitCode !== null || child.signalCode !== null) {
    return;
  }
  const exited = once(child, "exit");
  child.kill("SIGTERM");
  const timeout = setTimeout(() => child.kill("SIGKILL"), graceMs);
  await exited;
  clearTimeout(timeout);
}

export async function withLock<T>(
  options: { lockPath: string; waitingFor: string; timeoutMs: number },
  action: () => Promise<T>,
): Promise<T> {
  const { lockPath } = options;

  await waitFor(
    options.waitingFor,
    async () => {
      try {
        await fs.mkdir(lockPath);
        await fs.writeFile(path.join(lockPath, "pid"), String(process.pid));
        return true;
      } catch (error) {
        if (!isErrorWithCode(error, "EEXIST")) {
          throw error;
        }
      }
      const holder = await readLockHolder(lockPath);
      if (holder !== undefined && !isProcessAlive(holder)) {
        await takeOverStaleLock(lockPath);
      }
      return undefined;
    },
    options.timeoutMs,
  );
  try {
    return await action();
  } finally {
    await fs.rm(lockPath, { recursive: true, force: true });
  }
}

async function readLockHolder(lockPath: string): Promise<number | undefined> {
  const holder = Number.parseInt(
    await fs.readFile(path.join(lockPath, "pid"), "utf8").catch(() => ""),
    10,
  );
  return Number.isInteger(holder) ? holder : undefined;
}

async function takeOverStaleLock(lockPath: string): Promise<void> {
  const takeoverPath = `${lockPath}.takeover`;
  try {
    await fs.mkdir(takeoverPath);
  } catch (error) {
    if (!isErrorWithCode(error, "EEXIST")) {
      throw error;
    }
    await removeAbandonedTakeover(takeoverPath);
    return;
  }

  try {
    const holder = await readLockHolder(lockPath);
    if (holder !== undefined && !isProcessAlive(holder)) {
      await fs.rm(lockPath, { recursive: true, force: true });
    }
  } finally {
    await fs.rm(takeoverPath, { recursive: true, force: true });
  }
}

async function removeAbandonedTakeover(takeoverPath: string): Promise<void> {
  const stats = await fs.stat(takeoverPath).catch(() => undefined);
  if (
    stats !== undefined &&
    Temporal.Now.instant().epochMilliseconds - stats.mtimeMs > TAKEOVER_ABANDONED_AFTER_MS
  ) {
    await fs.rm(takeoverPath, { recursive: true, force: true });
  }
}

export function isErrorWithCode(error: unknown, code: string): boolean {
  return error instanceof Error && "code" in error && error.code === code;
}

function isProcessAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return !isErrorWithCode(error, "ESRCH");
  }
}

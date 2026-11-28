import childProcess from "node:child_process";
import { once } from "node:events";
import fs from "node:fs/promises";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { setTimeout as sleep } from "node:timers/promises";

import { SYSTEM_IMAGE_PACKAGE, type AndroidHost } from "#src/android/preflight.ts";
import { isErrorWithCode, run, stopChild, waitFor, withLock } from "#src/host.ts";

export type Emulator = {
  readonly serial: string;
  stop(): Promise<void>;
};

export type ListedProcess = {
  readonly pid: number;
  readonly ppid: number;
  readonly command: string;
};

const AVD_HOME = path.join(os.homedir(), "Library", "Caches", "cup-mobile-e2e", "avd");
const AVD_NAME = "cup-mobile-e2e-api36-ram4g";
const AVD_ARGUMENT = `-avd ${AVD_NAME} `;
const LAUNCHD_PID = 1;
const RAM_SIZE = "4096";
const SNAPSHOT_READY_MARKER = path.join(AVD_HOME, `${AVD_NAME}.snapshot-ready`);
const PREPARATION_LOCK = path.join(AVD_HOME, `${AVD_NAME}.lock`);

const BOOT_TIMEOUT_MS = 180_000;
const CHROME_PACKAGE = "com.android.chrome";
const CHROME_COMMAND_LINE_FILE = "/data/local/tmp/chrome-command-line";
const CHROME_TEST_FLAGS = "--disable-fre --no-default-browser-check --no-first-run";

export async function bootEmulator(host: AndroidHost): Promise<Emulator> {
  await prepareSnapshot(host);
  const { serial, process: emulatorProcess } = await startEmulator(host, ["-read-only"]);

  const stop = async (): Promise<void> => {
    if (emulatorProcess.exitCode === null && emulatorProcess.signalCode === null) {
      await run(host.adb, ["-s", serial, "emu", "kill"]).catch(() => undefined);
      const exited = once(emulatorProcess, "exit");
      const timeout = setTimeout(() => emulatorProcess.kill("SIGKILL"), 15_000);
      await exited;
      clearTimeout(timeout);
    }
  };

  try {
    await waitForBoot(host, serial, emulatorProcess);
    await run(host.adb, [
      "-s",
      serial,
      "shell",
      "settings",
      "put",
      "global",
      "hide_error_dialogs",
      "1",
    ]);
    await skipChromeFirstRun(host, serial);
  } catch (error) {
    await stop();
    throw error;
  }
  return { serial, stop };
}

async function skipChromeFirstRun(host: AndroidHost, serial: string): Promise<void> {
  await run(host.adb, [
    "-s",
    serial,
    "shell",
    `echo '_ ${CHROME_TEST_FLAGS}' > ${CHROME_COMMAND_LINE_FILE}`,
  ]);
  await run(host.adb, [
    "-s",
    serial,
    "shell",
    "am",
    "set-debug-app",
    "--persistent",
    CHROME_PACKAGE,
  ]);
  await run(host.adb, ["-s", serial, "shell", "am", "force-stop", CHROME_PACKAGE]);
}

export function findOrphanedEmulators(processes: readonly ListedProcess[]): number[] {
  const emulatorProcesses = processes.filter(({ command }) => command.includes(AVD_ARGUMENT));
  const emulatorByPid = new Map(emulatorProcesses.map((listed) => [listed.pid, listed]));

  const isOrphaned = (listed: ListedProcess): boolean => {
    let parent = listed.ppid;
    for (let ancestor = emulatorByPid.get(parent); ancestor; ancestor = emulatorByPid.get(parent)) {
      parent = ancestor.ppid;
    }
    return parent === LAUNCHD_PID;
  };
  return emulatorProcesses.filter((listed) => isOrphaned(listed)).map(({ pid }) => pid);
}

export async function stopOrphanedEmulators(): Promise<void> {
  const orphaned = findOrphanedEmulators(await listProcesses());
  if (orphaned.length === 0) {
    return;
  }

  process.stderr.write(
    `Stopping emulator processes ${orphaned.join(", ")}, left behind by a run that no longer runs.\n`,
  );
  signalAll(orphaned, "SIGTERM");
  const remaining = await waitForOrphansToQuit(orphaned, 15_000);
  if (remaining.length === 0) {
    return;
  }
  signalAll(remaining, "SIGKILL");
  const survivors = await waitForOrphansToQuit(remaining, 5000);
  if (survivors.length > 0) {
    throw new Error(`The left-behind emulator processes ${survivors.join(", ")} survived SIGKILL.`);
  }
}

async function waitForOrphansToQuit(pids: readonly number[], timeoutMs: number): Promise<number[]> {
  const deadline = performance.now() + timeoutMs;
  for (;;) {
    const remaining = findOrphanedEmulators(await listProcesses()).filter((pid) =>
      pids.includes(pid),
    );
    if (remaining.length === 0 || performance.now() > deadline) {
      return remaining;
    }
    await sleep(250);
  }
}

async function listProcesses(): Promise<ListedProcess[]> {
  const { stdout } = await run("ps", ["-ww", "-axo", "pid=,ppid=,command="]);
  return stdout
    .split("\n")
    .filter((line) => line.trim() !== "")
    .map((line) => {
      const match = /^\s*(\d+)\s+(\d+)\s+(.*)$/u.exec(line);
      if (match === null) {
        throw new TypeError(`\`ps\` printed a line without a process ID and parent: ${line}`);
      }
      const [, pid, ppid, command = ""] = match;
      return { pid: Number(pid), ppid: Number(ppid), command };
    });
}

async function prepareSnapshot(host: AndroidHost): Promise<void> {
  await fs.mkdir(AVD_HOME, { recursive: true });
  if (await exists(SNAPSHOT_READY_MARKER)) {
    return;
  }

  await withLock(
    {
      lockPath: PREPARATION_LOCK,
      waitingFor: "another run to finish preparing the emulator snapshot",
      timeoutMs: 15 * 60_000,
    },
    async () => {
      if (await exists(SNAPSHOT_READY_MARKER)) {
        return;
      }
      process.stderr.write(
        `Preparing the suite's Android emulator ${AVD_NAME} and its Quick Boot snapshot once for this Mac; this takes a few minutes.\n`,
      );
      await run(
        host.avdManager,
        [
          "create",
          "avd",
          "--force",
          "--name",
          AVD_NAME,
          "--package",
          SYSTEM_IMAGE_PACKAGE,
          "--device",
          "pixel_8",
        ],
        { env: androidEnvironment(host) },
      );
      await setAvdConfig("hw.ramSize", RAM_SIZE);
      const { serial, process: emulatorProcess } = await startEmulator(host, ["-no-snapshot-load"]);
      try {
        await waitForBoot(host, serial, emulatorProcess);
        await run(host.adb, ["-s", serial, "emu", "kill"]);
        await waitFor(
          "the emulator to save its snapshot and quit",
          () =>
            Promise.resolve(
              emulatorProcess.exitCode !== null || emulatorProcess.signalCode !== null
                ? true
                : undefined,
            ),
          120_000,
        );
      } finally {
        await stopChild(emulatorProcess);
      }
      await fs.writeFile(SNAPSHOT_READY_MARKER, "");
    },
  );
}

async function startEmulator(
  host: AndroidHost,
  extraArgs: readonly string[],
): Promise<{ serial: string; process: childProcess.ChildProcess }> {
  const report = await listenForConsoleReport();
  const emulatorProcess = childProcess.spawn(
    host.emulator,
    [
      "-avd",
      AVD_NAME,
      "-no-window",
      "-no-audio",
      "-no-boot-anim",
      "-report-console",
      `tcp:${report.port}`,
      ...extraArgs,
    ],
    { env: androidEnvironment(host), stdio: ["ignore", "pipe", "pipe"] },
  );
  const output: string[] = [];
  emulatorProcess.stdout?.setEncoding("utf8").on("data", (chunk: string) => output.push(chunk));
  emulatorProcess.stderr?.setEncoding("utf8").on("data", (chunk: string) => output.push(chunk));

  try {
    const consolePort = await Promise.race([
      report.consolePort,
      once(emulatorProcess, "exit").then(() => {
        throw new Error(
          `The emulator exited before it reported its console port.\n${output.join("")}`,
        );
      }),
    ]);
    return { serial: `emulator-${consolePort}`, process: emulatorProcess };
  } catch (error) {
    await stopChild(emulatorProcess);
    throw error;
  } finally {
    report.close();
  }
}

async function listenForConsoleReport(): Promise<{
  port: number;
  consolePort: Promise<number>;
  close(): void;
}> {
  const server = net.createServer();
  const consolePort = new Promise<number>((resolve, reject) => {
    server.on("connection", (socket) => {
      let data = "";
      socket.setEncoding("utf8").on("data", (chunk: string) => (data += chunk));
      socket.on("end", () => {
        const port = Number.parseInt(data.trim(), 10);
        if (Number.isInteger(port)) {
          resolve(port);
        } else {
          reject(new Error(`The emulator reported an invalid console port: ${data}`));
        }
      });
    });
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  if (address === null || typeof address === "string") {
    throw new Error("The operating system assigned no port for the emulator's console report.");
  }
  return { port: address.port, consolePort, close: () => server.close() };
}

async function waitForBoot(
  host: AndroidHost,
  serial: string,
  emulatorProcess: childProcess.ChildProcess,
): Promise<void> {
  await waitFor(
    `${serial} to finish booting`,
    async () => {
      if (emulatorProcess.exitCode !== null) {
        throw new Error(`The emulator ${serial} exited while booting.`);
      }
      const result = await run(host.adb, [
        "-s",
        serial,
        "shell",
        "getprop",
        "sys.boot_completed",
      ]).catch(() => undefined);
      return result?.stdout.trim() === "1" ? true : undefined;
    },
    BOOT_TIMEOUT_MS,
  );
}

async function setAvdConfig(key: string, value: string): Promise<void> {
  const configPath = path.join(AVD_HOME, `${AVD_NAME}.avd`, "config.ini");
  const lines = (await fs.readFile(configPath, "utf8"))
    .split("\n")
    .filter((line) => !line.startsWith(`${key} `) && !line.startsWith(`${key}=`));
  await fs.writeFile(
    configPath,
    [...lines.filter((line) => line !== ""), `${key} = ${value}`, ""].join("\n"),
  );
}

function androidEnvironment(host: AndroidHost): NodeJS.ProcessEnv {
  return {
    ...process.env,
    ANDROID_HOME: host.sdkRoot,
    ANDROID_SDK_ROOT: host.sdkRoot,
    ANDROID_AVD_HOME: AVD_HOME,
  };
}

async function exists(filePath: string): Promise<boolean> {
  return fs.access(filePath).then(
    () => true,
    () => false,
  );
}

function signalAll(pids: readonly number[], signal: NodeJS.Signals): void {
  for (const pid of pids) {
    try {
      process.kill(pid, signal);
    } catch (error) {
      if (!isErrorWithCode(error, "ESRCH")) {
        throw error;
      }
    }
  }
}

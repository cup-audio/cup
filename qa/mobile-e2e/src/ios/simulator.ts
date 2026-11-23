import childProcess from "node:child_process";
import crypto from "node:crypto";

import { run } from "#src/host.ts";
import type { IosHost } from "#src/ios/preflight.ts";
import {
  isRunOwnerAlive,
  readProcessStartTimes,
  readRunOwner,
  type RunOwner,
  type StartTimeLookup,
} from "#src/run-owner.ts";

export type Simulator = {
  readonly udid: string;
  delete(): Promise<void>;
};

export type ListedSimulator = {
  readonly udid: string;
  readonly name: string;
};

const NAME_PREFIX = "cup-mobile-e2e-";
const OWNED_NAME = /^cup-mobile-e2e-(\d+)-(\d{14})-[\da-f]{8}$/u;

export function simulatorName(owner: RunOwner): string {
  return `${NAME_PREFIX}${owner.pid}-${owner.startedAt}-${crypto.randomUUID().slice(0, 8)}`;
}

export function findOrphanedSimulators(
  simulators: readonly ListedSimulator[],
  startTimeOf: StartTimeLookup,
): string[] {
  return simulators
    .filter(({ name }) => {
      const match = OWNED_NAME.exec(name);
      if (match === null) {
        return false;
      }
      const [, pid, startedAt = ""] = match;
      return !isRunOwnerAlive({ pid: Number(pid), startedAt }, startTimeOf);
    })
    .map(({ udid }) => udid);
}

export async function deleteOrphanedSimulators(): Promise<void> {
  const [simulators, startTimeOf] = await Promise.all([listSimulators(), readProcessStartTimes()]);
  for (const udid of findOrphanedSimulators(simulators, startTimeOf)) {
    process.stderr.write(`Deleting simulator ${udid}, left behind by a run that no longer runs.\n`);
    await run("pkill", ["-f", xcodebuildPattern(udid)], { successExitCodes: [0, 1] });
    await run("xcrun", ["simctl", "shutdown", udid]).catch(() => undefined);
    try {
      await run("xcrun", ["simctl", "delete", udid]);
    } catch (error) {
      if ((await listSimulators()).some((simulator) => simulator.udid === udid)) {
        throw error;
      }
    }
  }
}

export async function createSimulator(host: IosHost): Promise<Simulator> {
  const name = simulatorName(await readRunOwner());
  const { stdout } = await run("xcrun", [
    "simctl",
    "create",
    name,
    host.deviceTypeIdentifier,
    host.runtime.identifier,
  ]);
  const udid = stdout.trim();
  const watcher = watchForOrphan(udid);

  const deleteSimulator = async (): Promise<void> => {
    await run("pkill", ["-f", xcodebuildPattern(udid)]).catch(() => undefined);
    await run("xcrun", ["simctl", "shutdown", udid]).catch(() => undefined);
    await run("xcrun", ["simctl", "delete", udid]);
    watcher.kill();
  };

  try {
    await run("xcrun", ["simctl", "boot", udid]);
    await run("xcrun", ["simctl", "bootstatus", udid]);
  } catch (error) {
    await deleteSimulator();
    throw error;
  }
  return { udid, delete: deleteSimulator };
}

function watchForOrphan(udid: string): childProcess.ChildProcess {
  const watcher = childProcess.spawn(
    "/bin/sh",
    [
      "-c",
      'while kill -0 "${1}" 2>/dev/null; do sleep 1; done; pkill -f "${3}"; xcrun simctl shutdown "${2}"; xcrun simctl delete "${2}"',
      "simulator-watcher",
      String(process.pid),
      udid,
      xcodebuildPattern(udid),
    ],
    { detached: true, stdio: "ignore" },
  );
  watcher.unref();
  return watcher;
}

function xcodebuildPattern(udid: string): string {
  return `[x]codebuild .*-destination id=${udid}`;
}

async function listSimulators(): Promise<ListedSimulator[]> {
  const { stdout } = await run("xcrun", ["simctl", "list", "devices", "--json"]);
  const listing: unknown = JSON.parse(stdout);
  if (!isRecord(listing) || !isRecord(listing["devices"])) {
    throw new TypeError(`\`simctl list devices --json\` printed no devices: ${stdout}`);
  }
  return Object.values(listing["devices"]).flatMap((devices: unknown): ListedSimulator[] =>
    Array.isArray(devices)
      ? devices.flatMap((device: unknown): ListedSimulator[] =>
          isRecord(device) &&
          typeof device["udid"] === "string" &&
          typeof device["name"] === "string"
            ? [{ udid: device["udid"], name: device["name"] }]
            : [],
        )
      : [],
  );
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

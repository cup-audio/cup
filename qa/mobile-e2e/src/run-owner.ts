import { run } from "#src/host.ts";

export type RunOwner = {
  readonly pid: number;
  readonly startedAt: string;
};

export type StartTimeLookup = (pid: number) => string | undefined;

const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];

const START_TIME_LINE =
  /^\s*(\d+)\s+[A-Z][a-z]{2}\s+([A-Z][a-z]{2})\s+(\d{1,2})\s+(\d{2}):(\d{2}):(\d{2})\s+(\d{4})\s*$/u;

export async function readRunOwner(): Promise<RunOwner> {
  const startedAt = parseProcessStartTimes(
    await readPs(["-o", "pid=,lstart=", "-p", String(process.pid)]),
  )(process.pid);
  if (startedAt === undefined) {
    throw new Error(`\`ps\` did not list this process, ${process.pid}.`);
  }
  return { pid: process.pid, startedAt };
}

export function isRunOwnerAlive(owner: RunOwner, startTimeOf: StartTimeLookup): boolean {
  return startTimeOf(owner.pid) === owner.startedAt;
}

export async function readProcessStartTimes(): Promise<StartTimeLookup> {
  return parseProcessStartTimes(await readPs(["-axo", "pid=,lstart="]));
}

export function parseProcessStartTimes(stdout: string): StartTimeLookup {
  const startTimes = new Map<number, string>();
  for (const line of stdout.split("\n")) {
    if (line.trim() === "") {
      continue;
    }
    const match = START_TIME_LINE.exec(line);
    const month = match === null ? -1 : MONTHS.indexOf(match[2] ?? "");
    if (match === null || month === -1) {
      throw new TypeError(`\`ps\` printed a line without a process ID and start time: ${line}`);
    }
    const [, pid, , day = "", hours = "", minutes = "", seconds = "", year = ""] = match;
    const startedAt = `${year}${String(month + 1).padStart(2, "0")}${day.padStart(2, "0")}${hours}${minutes}${seconds}`;
    startTimes.set(Number(pid), startedAt);
  }
  return (pid) => startTimes.get(pid);
}

async function readPs(args: readonly string[]): Promise<string> {
  const { stdout } = await run("ps", args, { env: { ...process.env, LC_ALL: "C" } });
  return stdout;
}

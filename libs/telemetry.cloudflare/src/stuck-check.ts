import { captureEvent, type Event } from "@sentry/core";

export type StuckCheck<Case> = {
  idOf(stuckCase: Case): string;
  startedAtMsOf(stuckCase: Case): number;
  isStuck(stuckCase: Case, ageMs: number): boolean;
  toEvent(stuckCase: Case, ageMs: number): Event;
};

export function reportStuckCases<Case>(
  cases: readonly Case[],
  nowMs: number,
  check: StuckCheck<Case>,
): string[] {
  const reported: string[] = [];
  for (const stuckCase of cases) {
    const ageMs = nowMs - check.startedAtMsOf(stuckCase);
    if (!check.isStuck(stuckCase, ageMs)) {
      continue;
    }
    captureEvent({ level: "error", ...check.toEvent(stuckCase, ageMs) });
    reported.push(check.idOf(stuckCase));
  }
  return reported;
}

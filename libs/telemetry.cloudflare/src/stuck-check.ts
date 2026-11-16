import { captureEvent, type Event } from "@sentry/core";

/** What one stuck check knows about its cases. */
export type StuckCheck<Case> = {
  /** The ID the owner stores the reported flag under. */
  idOf(stuckCase: Case): string;
  /** When the case's current wait started. */
  startedAtMsOf(stuckCase: Case): number;
  /** Whether a case of this age is stuck, by the check's threshold. */
  isStuck(stuckCase: Case, ageMs: number): boolean;
  /**
   * The Sentry error event of a stuck case. Its message names the case, so that Sentry's Dedupe
   * integration does not drop the next case's event as a repeat; its fixed fingerprint groups the
   * cases into one issue.
   */
  toEvent(stuckCase: Case, ageMs: number): Event;
};

/**
 * The loop of every stuck check: sends one Sentry error event for each case that is stuck at
 * `nowMs`, and returns the IDs of the cases it reported, so the owner stores that the event was
 * sent and skips them from then on.
 */
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

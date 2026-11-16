import { captureEvent } from "@sentry/core";

import { TELEMETRY_ATTRIBUTES } from "@cup/telemetry.core";

/** A marked conversion the stuck-conversion-deletion check has not reported. */
export type StuckConversionDeletionCandidate = {
  conversionId: string;
  /** When the conversion was marked for deletion. */
  deletingSinceMs: number;
};

/**
 * A conversion still marked this long after it was marked is stuck. Age, not attempts: a cleanup
 * that silently waits on undrained artifact writers fails no pass, yet still counts.
 */
const CONVERSION_DELETION_STUCK_AFTER_MS = 60 * 60 * 1_000;

/**
 * The stuck-conversion-deletion check that the account alarm runs: sends one Sentry error event for
 * each candidate marked more than 1 h before `nowMs`, and returns the conversion IDs it reported,
 * so the account stores that the event was sent. All events share one fingerprint, so they group
 * into one Sentry issue. The event names no root cause; the per-pass
 * `conversion-deletion-cleanup-failed` warnings hold it.
 */
export function reportStuckConversionDeletions(
  candidates: readonly StuckConversionDeletionCandidate[],
  nowMs: number,
): string[] {
  const reported: string[] = [];
  for (const candidate of candidates) {
    const ageMs = nowMs - candidate.deletingSinceMs;
    if (ageMs <= CONVERSION_DELETION_STUCK_AFTER_MS) {
      continue;
    }

    captureEvent({
      level: "error",
      // The conversion ID keeps Sentry's Dedupe integration from dropping the next conversion's
      // event as a repeat of this one; the fingerprint still groups them into one issue.
      message: `Deletion of conversion ${candidate.conversionId} stuck`,
      fingerprint: ["conversion-deletion-stuck"],
      tags: { [TELEMETRY_ATTRIBUTES.CONVERSION_ID]: candidate.conversionId },
      contexts: {
        stuck_conversion_deletion: { age_minutes: Math.floor(ageMs / 60_000) },
      },
    });
    reported.push(candidate.conversionId);
  }
  return reported;
}

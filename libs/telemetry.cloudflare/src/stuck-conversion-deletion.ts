import { TELEMETRY_ATTRIBUTES } from "@cup/telemetry.core";

import { reportStuckCases } from "#src/stuck-check.ts";

export type StuckConversionDeletionCandidate = {
  conversionId: string;
  deletingSinceMs: number;
};

const CONVERSION_DELETION_STUCK_AFTER_MS = 60 * 60 * 1_000;

export function reportStuckConversionDeletions(
  candidates: readonly StuckConversionDeletionCandidate[],
  nowMs: number,
): string[] {
  return reportStuckCases(candidates, nowMs, {
    idOf: (candidate) => candidate.conversionId,
    startedAtMsOf: (candidate) => candidate.deletingSinceMs,
    isStuck: (_candidate, ageMs) => ageMs > CONVERSION_DELETION_STUCK_AFTER_MS,
    toEvent: (candidate, ageMs) => ({
      message: `Deletion of conversion ${candidate.conversionId} stuck`,
      fingerprint: ["conversion-deletion-stuck"],
      tags: { [TELEMETRY_ATTRIBUTES.CONVERSION_ID]: candidate.conversionId },
      contexts: { stuck_conversion_deletion: { age_minutes: Math.floor(ageMs / 60_000) } },
    }),
  });
}

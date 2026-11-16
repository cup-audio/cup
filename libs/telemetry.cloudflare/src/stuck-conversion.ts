import type { ConversionOwner } from "@cup/conversion-contracts";
import { TELEMETRY_ATTRIBUTES } from "@cup/telemetry.core";

import { conversionOwnerKeys } from "#src/conversion-owner.ts";
import { reportStuckCases } from "#src/stuck-check.ts";

/** The stage a conversion can hang in: its preparation, or the synthesis of its audio segments. */
type ConversionStage = "preparation" | "synthesis";

/** A conversion the stuck-conversion check looks at: one whose current stage it has not reported. */
export type StuckConversionCandidate = {
  conversionId: string;
  stage: ConversionStage;
  /** When the stage last started: preparation accepted or retried, or synthesis started again. */
  stageStartedAtMs: number;
  /** The conversion phase the conversion last started; only preparation reports it. */
  lastStartedPhase: string;
};

/*
 * The thresholds are deliberately generous, so that only a hung Workflow or segment crosses them;
 * tighten them once conversion durations are visible in Sentry.
 */

/** A conversion still `pending` this long after preparation started is stuck in preparation. */
const PREPARATION_STUCK_AFTER_MS = 15 * 60 * 1_000;

/** A conversion with a segment still reserved this long after synthesis started is stuck. */
const SYNTHESIS_STUCK_AFTER_MS = 60 * 60 * 1_000;

const STUCK_AFTER_MS_BY_STAGE: Record<ConversionStage, number> = {
  preparation: PREPARATION_STUCK_AFTER_MS,
  synthesis: SYNTHESIS_STUCK_AFTER_MS,
};

/**
 * The stuck-conversion check that both owners' alarms run: sends one Sentry error event for each
 * candidate past its stage's threshold at `nowMs`, and returns the conversion IDs it reported, so
 * the owner stores that the event was sent and skips the conversion until its stage starts again.
 * All events of a stage share one fingerprint, so they group into one Sentry issue per stage.
 */
export function reportStuckConversions(
  candidates: readonly StuckConversionCandidate[],
  owner: ConversionOwner,
  nowMs: number,
): string[] {
  return reportStuckCases(candidates, nowMs, {
    idOf: (candidate) => candidate.conversionId,
    startedAtMsOf: (candidate) => candidate.stageStartedAtMs,
    isStuck: (candidate, ageMs) => ageMs >= STUCK_AFTER_MS_BY_STAGE[candidate.stage],
    toEvent: (candidate, ageMs) => ({
      message: `Conversion ${candidate.conversionId} stuck in ${candidate.stage}`,
      fingerprint: ["conversion-stuck", candidate.stage],
      tags: {
        [TELEMETRY_ATTRIBUTES.CONVERSION_ID]: candidate.conversionId,
        [TELEMETRY_ATTRIBUTES.CONVERSION_STAGE]: candidate.stage,
        ...(candidate.stage === "preparation"
          ? { [TELEMETRY_ATTRIBUTES.CONVERSION_PHASE]: candidate.lastStartedPhase }
          : {}),
        ...conversionOwnerKeys(owner),
      },
      contexts: {
        stuck_conversion: { stage: candidate.stage, age_minutes: Math.floor(ageMs / 60_000) },
      },
    }),
  });
}

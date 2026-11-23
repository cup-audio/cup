import type { ConversionOwner, ConversionPhase } from "@cup/conversion-contracts";
import { TELEMETRY_ATTRIBUTES } from "@cup/telemetry.core";

import { conversionOwnerKeys } from "#src/conversion-owner.ts";
import { reportStuckCases } from "#src/stuck-check.ts";

type ConversionStage = "preparation" | "synthesis";

export type StuckConversionCandidate = {
  conversionId: string;
  status: "pending" | "ready" | "failed";
  hasReservedSegment: boolean;
  stageStartedAtMs: number;
  lastStartedPhase: ConversionPhase;
};

const PREPARATION_STUCK_AFTER_MS = 15 * 60 * 1_000;

const SYNTHESIS_STUCK_AFTER_MS = 60 * 60 * 1_000;

const STUCK_AFTER_MS_BY_STAGE: Record<ConversionStage, number> = {
  preparation: PREPARATION_STUCK_AFTER_MS,
  synthesis: SYNTHESIS_STUCK_AFTER_MS,
};

export function reportStuckConversions(
  candidates: readonly StuckConversionCandidate[],
  owner: ConversionOwner,
  nowMs: number,
): string[] {
  const staged = candidates.flatMap((candidate) => {
    const stage = stageOf(candidate);
    return stage === undefined ? [] : [{ ...candidate, stage }];
  });
  return reportStuckCases(staged, nowMs, {
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

function stageOf(candidate: StuckConversionCandidate): ConversionStage | undefined {
  if (candidate.status === "pending") {
    return "preparation";
  }
  if (candidate.status === "ready" && candidate.hasReservedSegment) {
    return "synthesis";
  }
  return undefined;
}

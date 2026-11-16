import { captureEvent } from "@sentry/core";

import { TELEMETRY_ATTRIBUTES } from "@cup/telemetry.core";

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

type ConversionOwnerReference =
  | { kind: "account"; accountId: string }
  | { kind: "grant"; grantId: string };

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
  owner: ConversionOwnerReference,
  nowMs: number,
): string[] {
  const reported: string[] = [];
  for (const candidate of candidates) {
    const ageMs = nowMs - candidate.stageStartedAtMs;
    if (ageMs < STUCK_AFTER_MS_BY_STAGE[candidate.stage]) {
      continue;
    }

    captureEvent({
      level: "error",
      // The conversion ID keeps Sentry's Dedupe integration from dropping the next conversion's
      // event as a repeat of this one; the fingerprint still groups them into one issue.
      message: `Conversion ${candidate.conversionId} stuck in ${candidate.stage}`,
      fingerprint: ["conversion-stuck", candidate.stage],
      tags: {
        [TELEMETRY_ATTRIBUTES.CONVERSION_ID]: candidate.conversionId,
        [TELEMETRY_ATTRIBUTES.CONVERSION_STAGE]: candidate.stage,
        ...(candidate.stage === "preparation"
          ? { [TELEMETRY_ATTRIBUTES.CONVERSION_PHASE]: candidate.lastStartedPhase }
          : {}),
        [TELEMETRY_ATTRIBUTES.OWNER_KIND]: owner.kind,
        ...(owner.kind === "account"
          ? { [TELEMETRY_ATTRIBUTES.ACCOUNT_ID]: owner.accountId }
          : { [TELEMETRY_ATTRIBUTES.CONVERSION_GRANT_ID]: owner.grantId }),
      },
      contexts: {
        stuck_conversion: {
          stage: candidate.stage,
          age_minutes: Math.floor(ageMs / 60_000),
        },
      },
    });
    reported.push(candidate.conversionId);
  }
  return reported;
}

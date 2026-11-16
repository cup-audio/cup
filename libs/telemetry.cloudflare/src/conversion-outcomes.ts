import { TELEMETRY_ATTRIBUTES } from "@cup/telemetry.core";

import { logEvent } from "#src/log-event.ts";

/** How a preparation ended, as the owner recorded it. */
export type PreparationOutcome =
  | { outcome: "ready" | "insufficient-duration" }
  | { outcome: "failed"; failureCategory: string };

/** Sends `conversion-preparation-settled` once a conversion owner recorded a preparation outcome. */
export function logPreparationSettled(
  input: PreparationOutcome & {
    conversionId: string;
    conversionCreatedAtMs: number;
    settledAtMs: number;
  },
): void {
  logEvent(
    "conversion-preparation-settled",
    `The preparation of conversion ${input.conversionId} settled ${input.outcome}.`,
    {
      attributes: {
        [TELEMETRY_ATTRIBUTES.CONVERSION_ID]: input.conversionId,
        [TELEMETRY_ATTRIBUTES.CONVERSION_OUTCOME]: input.outcome,
        [TELEMETRY_ATTRIBUTES.CONVERSION_FAILURE_CATEGORY]:
          input.outcome === "failed" ? input.failureCategory : undefined,
        [TELEMETRY_ATTRIBUTES.CONVERSION_ELAPSED_MS]:
          input.settledAtMs - input.conversionCreatedAtMs,
      },
    },
  );
}

/**
 * Sends `audio-segment-settled` once a conversion owner settled or released a segment and, when no
 * segment of the conversion is still reserved afterwards, `conversion-synthesis-settled`.
 */
export function logAudioSegmentSettled(input: {
  conversionId: string;
  sequence: number;
  outcome: "settled" | "released";
  /** When the segment's reservation was taken; absent when the owner cannot tell. */
  reservedAtMs: number | undefined;
  /** The synthesis attempts the segment's Workflow reported; absent for an alarm's release. */
  attempts: number | undefined;
  conversionCreatedAtMs: number;
  /** The states of all of the conversion's segments after this one settled. */
  segmentStates: readonly ("reserved" | "settled" | "released")[];
  settledAtMs: number;
}): void {
  logEvent(
    "audio-segment-settled",
    `Audio segment ${input.sequence} of conversion ${input.conversionId} ${input.outcome}.`,
    {
      attributes: {
        [TELEMETRY_ATTRIBUTES.CONVERSION_ID]: input.conversionId,
        [TELEMETRY_ATTRIBUTES.AUDIO_SEGMENT_SEQUENCE]: input.sequence,
        [TELEMETRY_ATTRIBUTES.AUDIO_SEGMENT_OUTCOME]: input.outcome,
        [TELEMETRY_ATTRIBUTES.AUDIO_SEGMENT_SYNTHESIS_MS]:
          input.reservedAtMs === undefined ? undefined : input.settledAtMs - input.reservedAtMs,
        [TELEMETRY_ATTRIBUTES.AUDIO_SEGMENT_ATTEMPTS]: input.attempts,
      },
    },
  );

  if (input.segmentStates.includes("reserved")) {
    return;
  }
  const failedSegments = input.segmentStates.filter((state) => state === "released").length;
  logEvent(
    "conversion-synthesis-settled",
    `The synthesis of conversion ${input.conversionId} settled with ${failedSegments} failed segment(s).`,
    {
      attributes: {
        [TELEMETRY_ATTRIBUTES.CONVERSION_ID]: input.conversionId,
        [TELEMETRY_ATTRIBUTES.CONVERSION_FAILED_SEGMENTS]: failedSegments,
        // Without a failed segment, this is when the narration track came to exist.
        [TELEMETRY_ATTRIBUTES.CONVERSION_ELAPSED_MS]:
          input.settledAtMs - input.conversionCreatedAtMs,
      },
    },
  );
}

import type { ConversionFailureCategory } from "@cup/conversion-contracts";
import { TELEMETRY_ATTRIBUTES } from "@cup/telemetry.core";

import { logEvent } from "#src/log-event.ts";

export type PreparationOutcome =
  | { outcome: "ready" | "insufficient-duration" }
  | { outcome: "failed"; failureCategory: ConversionFailureCategory };

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

export function logAudioSegmentSettled(input: {
  conversionId: string;
  sequence: number;
  outcome: "settled" | "released";
  reservedAtMs: number | undefined;
  attempts: number | undefined;
  conversionCreatedAtMs: number;
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
        [TELEMETRY_ATTRIBUTES.AUDIO_SEGMENT_RESERVED_MS]:
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
        [TELEMETRY_ATTRIBUTES.CONVERSION_ELAPSED_MS]:
          input.settledAtMs - input.conversionCreatedAtMs,
      },
    },
  );
}

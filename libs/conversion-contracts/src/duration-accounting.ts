import { z } from "zod";

import { CupError } from "@cup/errors";

const segmentUsageSchema = z
  .object({
    conversionId: z.string().min(1),
    sequence: z.number().int().nonnegative(),
    narrationTextCharacters: z.number().int().positive(),
    estimatedMilliseconds: z.number().int().positive(),
    state: z.enum(["reserved", "settled", "released"]),
    actualMilliseconds: z.number().int().nonnegative(),
    chargedMilliseconds: z.number().int().nonnegative(),
  })
  .strict();
export type SegmentUsage = z.infer<typeof segmentUsageSchema>;

export const insufficientDurationSchema = z
  .object({
    requiredMilliseconds: z.number().int().positive(),
    availableMilliseconds: z.number().int().nonnegative(),
  })
  .strict();
export type InsufficientDuration = z.infer<typeof insufficientDurationSchema>;

export type PreparedConversionStatus = "insufficient-duration" | "synthesizing" | "ready";

export function derivePreparedConversionStatus(
  usage: readonly Pick<SegmentUsage, "state">[],
): PreparedConversionStatus {
  if (usage.length === 0) {
    return "insufficient-duration";
  }
  return usage.some((segment) => segment.state === "reserved") ? "synthesizing" : "ready";
}

export function findNarrationTrackDurations(
  usage: readonly Pick<SegmentUsage, "sequence" | "state" | "actualMilliseconds">[],
): number[] | undefined {
  if (usage.length === 0 || usage.some((segment) => segment.state !== "settled")) {
    return undefined;
  }

  const segments = [...usage].sort((left, right) => left.sequence - right.sequence);
  if (segments.some((segment, index) => segment.sequence !== index)) {
    throw new CupError("Narration track segments must have consecutive sequences from 0");
  }

  return segments.map((segment) => segment.actualMilliseconds);
}

export function layOutConsecutively(lengths: readonly number[]): {
  startOffsets: number[];
  totalLength: number;
} {
  const startOffsets: number[] = [];
  let totalLength = 0;
  for (const length of lengths) {
    startOffsets.push(totalLength);
    totalLength += length;
  }
  return { startOffsets, totalLength };
}

export function estimateAudioDuration(narrationTextCharacters: number): number {
  if (!Number.isSafeInteger(narrationTextCharacters) || narrationTextCharacters < 1) {
    throw new CupError("Narration character count must be a positive safe integer");
  }
  const estimate = Math.max(1_000, narrationTextCharacters * 70);
  if (!Number.isSafeInteger(estimate)) {
    throw new CupError("Estimated duration exceeds supported precision");
  }
  return estimate;
}

import { captureException } from "@sentry/core";
import type { WorkflowEvent, WorkflowStep } from "cloudflare:workers";
import { NonRetryableError } from "cloudflare:workflows";

import {
  loadAudiobook,
  produceAudioSegment,
  PermanentNarrationSynthesisError,
  RateLimitedNarrationSynthesisError,
  type SpeechSynthesisAi,
} from "@cup/audiobook-production";
import {
  ConversionPhase,
  segmentWorkflowParamsSchema,
  type SegmentWorkflowParams,
} from "@cup/conversion-contracts";
import { setConversionScope } from "@cup/telemetry.cloudflare";
import { SEGMENT_FAILURE_CATEGORY, TELEMETRY_ATTRIBUTES } from "@cup/telemetry.core";

import { resolveConversionExecution } from "#src/conversion-execution.ts";
import { keepStepErrors, originalStepError } from "#src/keep-step-errors.ts";
import { phaseStepName } from "#src/phase-step-name.ts";
import type { AudiobookWorkflowEnvironment } from "#src/workflow-environment.ts";

const RATE_LIMIT_WAIT = "30 seconds";
const MAX_RATE_LIMIT_WAITS = 4;

export async function runAudioSegmentWorkflow({
  env,
  event,
  step: workflowStep,
  ai,
}: {
  env: AudiobookWorkflowEnvironment;
  event: WorkflowEvent<SegmentWorkflowParams>;
  step: WorkflowStep;
  ai: SpeechSynthesisAi;
}) {
  const step = keepStepErrors(workflowStep);
  const params = segmentWorkflowParamsSchema.parse(event.payload);
  const { conversionId, sequence } = params;
  if (event.instanceId !== `segment-${conversionId}-${sequence}`) {
    throw new NonRetryableError("Segment Workflow identity mismatch");
  }
  setConversionScope({ conversionId, owner: params.owner, sequence });

  const execution = resolveConversionExecution(env, params);
  const { artifactPrefix: prefix, artifactBucket: bucket } = execution;
  const loadPreparedNarration = async () => {
    const audiobook = await step.do(
      phaseStepName(ConversionPhase.AUDIO_SEGMENT_PRODUCTION, "load prepared narration"),
      async () => {
        const manifest = await execution.getReadyAudiobookReference();
        if (!manifest || manifest.key !== `${prefix}audiobook.json`) {
          throw new NonRetryableError("Prepared narration is unavailable");
        }
        return loadAudiobook({ bucket, audiobookReference: manifest });
      },
    );
    const unit = audiobook.narrationDocument.synchronizationUnits[sequence];
    if (!unit) {
      throw new NonRetryableError("Synchronization unit does not exist");
    }
    return { audiobook, unit };
  };

  let lastStepAttempts: number | undefined;
  const synthesize = (
    { audiobook, unit }: Awaited<ReturnType<typeof loadPreparedNarration>>,
    rateLimitWaits: number,
    earlierAttempts: number,
  ) =>
    step.do(
      phaseStepName(
        ConversionPhase.AUDIO_SEGMENT_PRODUCTION,
        rateLimitWaits === 0
          ? "synthesize and settle audio segment"
          : `synthesize and settle audio segment after rate limit wait ${rateLimitWaits}`,
      ),
      {
        retries: { limit: 2, delay: "5 seconds", backoff: "exponential" },
        timeout: "2 minutes",
      },
      async ({ attempt }) => {
        const attempts = earlierAttempts + attempt;
        lastStepAttempts = attempts;
        const state = await execution.getAudioSegmentState(sequence);
        if (state !== "reserved" && state !== "settled") {
          throw new NonRetryableError(
            "This segment has no duration reservation. Retry to generate the missing audio.",
          );
        }
        try {
          const segment = await produceAudioSegment({
            ai,
            bucket,
            conversionId,
            artifactPrefix: prefix,
            sequence,
            narrationChunk: { text: unit.narrationText },
            speechConfig: audiobook.speechConfig,
            narrationLanguage: audiobook.narrationLanguage,
            synthesisAttempt: attempt,
            synthesisResponseMode: attempt === 1 ? "streaming" : "non-streaming",
          });
          await execution.completeAudioSegment(sequence, segment.durationMilliseconds, attempts);
          return { result: "settled" as const, segment };
        } catch (error) {
          if (
            error instanceof RateLimitedNarrationSynthesisError &&
            rateLimitWaits < MAX_RATE_LIMIT_WAITS
          ) {
            return { result: "rate-limited" as const, attempts };
          }
          if (error instanceof PermanentNarrationSynthesisError) {
            throw new NonRetryableError(error.message);
          }
          throw error;
        }
      },
    );

  try {
    const narration = await loadPreparedNarration();
    let earlierAttempts = 0;
    for (let rateLimitWaits = 0; ; rateLimitWaits += 1) {
      const outcome = await synthesize(narration, rateLimitWaits, earlierAttempts);
      if (outcome.result === "settled") {
        return outcome.segment;
      }
      earlierAttempts = outcome.attempts;

      await step.sleep(
        `wait for speech provider rate limit ${rateLimitWaits + 1}`,
        RATE_LIMIT_WAIT,
      );
    }
  } catch (error) {
    await step.do(
      phaseStepName(ConversionPhase.AUDIO_SEGMENT_PRODUCTION, "release failed segment reservation"),
      async () => {
        await execution.releaseAudioSegment(sequence, lastStepAttempts);
        await bucket.put(
          `${prefix}segment-${sequence}-failure.json`,
          JSON.stringify({
            explanation:
              error instanceof Error
                ? error.message
                : "Speech generation failed. Retry this segment.",
          }),
          { httpMetadata: { contentType: "application/json" } },
        );
        captureException(originalStepError(error), {
          tags: { [TELEMETRY_ATTRIBUTES.CONVERSION_FAILURE_CATEGORY]: SEGMENT_FAILURE_CATEGORY },
        });
      },
    );
    throw error;
  }
}

import { captureException, uuid4 } from "@sentry/core";
import type { WorkflowEvent, WorkflowStep, WorkflowStepConfig } from "cloudflare:workers";
import { NonRetryableError } from "cloudflare:workflows";
import { Temporal } from "temporal-polyfill";

import {
  countNarrationTextCharactersBySegment,
  getNarrationLanguageSupport,
  SPEECH_CONFIG,
  storeAudiobook,
  storeCoverImage,
  type CoverImage,
  type CoverImageStorage,
} from "@cup/audiobook-production";
import {
  ConversionPhase,
  type ConversionFailureCategory,
  conversionParamsSchema,
  type ConversionParams,
} from "@cup/conversion-contracts";
import { CupError } from "@cup/errors";
import { createNarrationDocument } from "@cup/narration-document-creation";
import type {
  NarrationContentSelectionResult,
  NarrationLanguageDetectionInput,
  NarrationLanguageDetectionResult,
  NarrationLanguageDetectionRunner,
  SelectionChunkRunner,
} from "@cup/narration-source-analysis";
import type {
  CoverImageDeclaration,
  SourceMaterialPreparer,
  CoverImageLoader,
} from "@cup/prepare-source-material";
import { logEvent, setConversionScope } from "@cup/telemetry.cloudflare";
import { TELEMETRY_ATTRIBUTES } from "@cup/telemetry.core";

import { resolveConversionExecution } from "#src/conversion-execution.ts";
import { keepStepErrors, originalStepError } from "#src/keep-step-errors.ts";
import { phaseStepName } from "#src/phase-step-name.ts";
import type { AudiobookWorkflowEnvironment } from "#src/workflow-environment.ts";

const PREPARE_STEP_CONFIG = {
  retries: {
    limit: 2,
    delay: "10 seconds",
    backoff: "exponential",
  },
  timeout: "10 minutes",
} as const satisfies WorkflowStepConfig;

const AI_STEP_CONFIG = {
  retries: {
    limit: 2,
    delay: "10 seconds",
    backoff: "exponential",
  },
  timeout: "3 minutes",
} as const satisfies WorkflowStepConfig;

const PROCESSING_STEP_CONFIG = {
  retries: {
    limit: 0,
    delay: 0,
  },
  timeout: "10 minutes",
} as const satisfies WorkflowStepConfig;

// One retry covers a browser launch or connection that failed transiently; a refusal does not throw.
const COVER_IMAGE_STEP_CONFIG = {
  retries: {
    limit: 1,
    delay: "2 seconds",
  },
  timeout: "1 minute",
} as const satisfies WorkflowStepConfig;

const TERMINAL_STATE_STEP_CONFIG = {
  retries: {
    limit: 2,
    delay: "5 seconds",
    backoff: "exponential",
  },
  timeout: "1 minute",
} as const satisfies WorkflowStepConfig;

const MAX_NARRATION_TEXT_CHARACTERS = 40_000;
const MAX_NARRATION_CHUNKS = 200;

export type PrepareAudiobookWorkflowServices = {
  prepareSourceMaterial: SourceMaterialPreparer;
  loadCoverImage: CoverImageLoader;
  selectNarrationContent(
    sourceMaterialHtml: string,
    options: { conversionId: string; runChunk: SelectionChunkRunner },
  ): Promise<NarrationContentSelectionResult>;
  detectNarrationLanguage: (
    input: NarrationLanguageDetectionInput,
    options: { conversionId: string; runDetection: NarrationLanguageDetectionRunner },
  ) => Promise<NarrationLanguageDetectionResult>;
};

/** Runs a conversion through durable steps using explicitly supplied provider services. */
export async function runPrepareAudiobookWorkflow({
  env,
  event,
  step: workflowStep,
  services,
}: {
  env: AudiobookWorkflowEnvironment;
  event: WorkflowEvent<ConversionParams>;
  step: WorkflowStep;
  services: PrepareAudiobookWorkflowServices;
}) {
  // The failure capture reports a failed step's own error, so Cup's errors keep their messages.
  const step = keepStepErrors(workflowStep);
  const params = conversionParamsSchema.parse(event.payload);
  const { sourceUrl } = params;
  if ("v" in params && params.conversionId !== event.instanceId) {
    throw new NonRetryableError("Workflow conversion identity mismatch");
  }
  const owner = "v" in params ? params.owner : { kind: "trial" as const, grantId: params.grantId };
  const conversionId = event.instanceId;
  setConversionScope({ conversionId, owner });
  const execution = resolveConversionExecution(env, {
    conversionId,
    owner,
    executionEpoch: "v" in params ? params.executionEpoch : 1,
  });
  const { artifactPrefix, artifactBucket: bucket } = execution;
  let failureCategory: ConversionFailureCategory = "source-preparation";

  // Assigned once source preparation has finished; it never rejects.
  let coverImagePromise: Promise<CoverImage | undefined> | undefined;

  const result = await (async () => {
    try {
      const sourceMaterial = await step.do(
        phaseStepName(
          ConversionPhase.SOURCE_MATERIAL_PREPARATION,
          "prepare audiobook source material",
        ),
        PREPARE_STEP_CONFIG,
        async () => {
          await execution.phaseStarted(ConversionPhase.SOURCE_MATERIAL_PREPARATION);
          return services.prepareSourceMaterial(sourceUrl);
        },
      );

      // Started beside content selection and awaited only before the manifest is stored, so a
      // slow image host does not delay selection.
      coverImagePromise = storeDeclaredCoverImage({
        artifactPrefix,
        bucket,
        conversionId,
        declaration: sourceMaterial.coverImage,
        loadCoverImage: services.loadCoverImage,
        sourceUrl,
        step,
      });

      failureCategory = "content-selection";
      await step.do(
        phaseStepName(
          ConversionPhase.NARRATION_CONTENT_SELECTION,
          "start narration content selection",
        ),
        PROCESSING_STEP_CONFIG,
        () => execution.phaseStarted(ConversionPhase.NARRATION_CONTENT_SELECTION),
      );
      const { selectedSourceMaterialHtml, usage: contentSelectionUsage } =
        await services.selectNarrationContent(sourceMaterial.html, {
          conversionId,
          runChunk: (chunkIndex, select) =>
            step.do(
              phaseStepName(
                ConversionPhase.NARRATION_CONTENT_SELECTION,
                `select narration content chunk ${chunkIndex + 1}`,
              ),
              AI_STEP_CONFIG,
              select,
            ),
        });

      const narrationDocument = await step.do(
        phaseStepName(ConversionPhase.NARRATION_DOCUMENT_CREATION, "create narration document"),
        PROCESSING_STEP_CONFIG,
        async () => {
          await execution.phaseStarted(ConversionPhase.NARRATION_DOCUMENT_CREATION);
          return createNarrationDocument({
            sourceTitle: sourceMaterial.title,
            ...(sourceMaterial.subtitle === undefined
              ? {}
              : { sourceSubtitle: sourceMaterial.subtitle }),
            sourceMaterialHtml: selectedSourceMaterialHtml,
          });
        },
      );
      const { synchronizationUnits } = narrationDocument;
      const narrationTextCharacters = synchronizationUnits.reduce(
        (total, unit) => total + unit.narrationText.length,
        0,
      );
      if (
        narrationTextCharacters > MAX_NARRATION_TEXT_CHARACTERS ||
        synchronizationUnits.length > MAX_NARRATION_CHUNKS
      ) {
        failureCategory = "content-limit";
        throw new ContentLimitError(narrationTextCharacters, synchronizationUnits.length);
      }

      const { narrationLanguage } = await detectNarrationLanguage({
        conversionId,
        detect: services.detectNarrationLanguage,
        input: {
          sourceTitle: sourceMaterial.title,
          sourceMaterialHtml: selectedSourceMaterialHtml,
          ...(sourceMaterial.declaredLanguage === undefined
            ? {}
            : { declaredLanguage: sourceMaterial.declaredLanguage }),
        },
        step,
      });

      const coverImage = await coverImagePromise;
      const audiobookReference = await step.do(
        phaseStepName(ConversionPhase.AUDIOBOOK_STORAGE, "store audiobook"),
        PROCESSING_STEP_CONFIG,
        async () => {
          await execution.phaseStarted(ConversionPhase.AUDIOBOOK_STORAGE);
          return storeAudiobook({
            bucket,
            conversionId,
            artifactPrefix,
            title: sourceMaterial.title,
            originalUrl: sourceUrl,
            narrationDocument,
            speechConfig: SPEECH_CONFIG,
            ...(narrationLanguage === undefined ? {} : { narrationLanguage }),
            ...(coverImage === undefined ? {} : { coverImage }),
          });
        },
      );

      return {
        audiobookReference,
        narrationTextCharactersBySegment: countNarrationTextCharactersBySegment(narrationDocument),
        readyOutcome: {
          title: sourceMaterial.title,
          audiobookReference,
          ...(coverImage === undefined ? {} : { hasCoverImage: true as const }),
          ...(narrationLanguage === undefined ? {} : { narrationLanguage }),
          measurements: {
            narrationTextCharacters,
            narrationChunks: synchronizationUnits.length,
          },
          providerUsage: {
            contentSelection: contentSelectionUsage,
          },
        },
      };
    } catch (error) {
      // Let a cover image step that is still running finish first, so it cannot write into the
      // conversion's prefix after the owner has started cleaning up the failed conversion.
      await coverImagePromise;

      const failedOutcome = await step.do(
        phaseStepName(ConversionPhase.FINALIZATION, "create failed conversion outcome"),
        PROCESSING_STEP_CONFIG,
        async () => {
          // A content limit is an expected outcome, which the `content-limit` warning records, inside
          // this step, which never retries: a replay of the run reuses the step's result instead of
          // logging again. Any other failure is captured once its outcome is recorded, under the
          // event ID chosen here, so that the outcome can carry it as its diagnostic reference.
          if (error instanceof ContentLimitError) {
            logEvent(
              "content-limit",
              "The narration exceeds the conversion's content ceiling; the preparation fails.",
              {
                attributes: {
                  [TELEMETRY_ATTRIBUTES.CONVERSION_ID]: conversionId,
                  [TELEMETRY_ATTRIBUTES.NARRATION_TEXT_CHARACTERS]: error.narrationTextCharacters,
                  [TELEMETRY_ATTRIBUTES.NARRATION_CHUNKS]: error.narrationChunks,
                },
              },
            );
          }
          await execution.phaseStarted(ConversionPhase.FINALIZATION);
          return {
            failureCategory,
            explanation:
              error instanceof ContentLimitError
                ? "The source content exceeds the narration limit of 40,000 characters or 200 chunks."
                : "Preparation failed. Retry to load this track.",
            ...(error instanceof ContentLimitError ? {} : { diagnosticReference: uuid4() }),
            cleanupState: "pending" as const,
            completedAtMs: Temporal.Now.instant().epochMilliseconds,
          };
        },
      );

      await step.do(
        phaseStepName(ConversionPhase.FINALIZATION, "record conversion failure"),
        TERMINAL_STATE_STEP_CONFIG,
        async () => {
          await execution.recordFailed(failedOutcome);
          // Last in the step, so only a run whose owner recorded the failure reports it, and a
          // replay of the run reuses the recorded step instead of capturing again. A run that
          // cannot record its failure stops, and the owner's alarm captures the stopped Workflow.
          if (failedOutcome.diagnosticReference !== undefined) {
            captureException(originalStepError(error), {
              event_id: failedOutcome.diagnosticReference,
              captureContext: {
                tags: {
                  [TELEMETRY_ATTRIBUTES.CONVERSION_FAILURE_CATEGORY]: failedOutcome.failureCategory,
                },
              },
            });
          }
        },
      );
      throw error;
    }
  })();

  const readyOutcome = await step.do(
    phaseStepName(ConversionPhase.FINALIZATION, "create ready conversion outcome"),
    PROCESSING_STEP_CONFIG,
    async () => {
      await execution.phaseStarted(ConversionPhase.FINALIZATION);
      return {
        ...result.readyOutcome,
        completedAtMs: Temporal.Now.instant().epochMilliseconds,
      };
    },
  );

  await step.do(
    phaseStepName(ConversionPhase.FINALIZATION, "record conversion ready"),
    TERMINAL_STATE_STEP_CONFIG,
    async () => {
      await execution.recordReady(readyOutcome, result.narrationTextCharactersBySegment);
    },
  );

  // The ready outcome already reserved every segment or none. Insufficient duration is a valid
  // result that leaves nothing to dispatch; the owner's alarm dispatches if this step fails.
  await step.do(
    phaseStepName(ConversionPhase.FINALIZATION, "start speech synthesis"),
    TERMINAL_STATE_STEP_CONFIG,
    async () => {
      await execution.startSynthesis(result.narrationTextCharactersBySegment);
    },
  );

  return result.audiobookReference;
}

/**
 * Keeps the declared cover image when it can be loaded. Every failure leaves the audiobook without
 * one instead of failing the conversion, so this never rejects.
 */
async function storeDeclaredCoverImage({
  artifactPrefix,
  bucket,
  conversionId,
  declaration,
  loadCoverImage,
  sourceUrl,
  step,
}: {
  artifactPrefix: string;
  bucket: CoverImageStorage;
  conversionId: string;
  declaration: CoverImageDeclaration | undefined;
  loadCoverImage: CoverImageLoader;
  sourceUrl: string;
  step: WorkflowStep;
}): Promise<CoverImage | undefined> {
  if (declaration === undefined) {
    return undefined;
  }

  let missingCause: MissingCoverImageCause;
  try {
    const outcome = await step.do(
      // Runs beside content selection; it keeps an image the source material declares.
      phaseStepName(ConversionPhase.SOURCE_MATERIAL_PREPARATION, "store cover image"),
      COVER_IMAGE_STEP_CONFIG,
      async () => {
        const loaded = await loadCoverImage(declaration, sourceUrl);
        if (loaded.result === "refused") {
          return loaded;
        }

        // The bytes are stored inside the step because a step result cannot carry them.
        const coverImage = await storeCoverImage({
          artifactPrefix,
          bucket,
          bytes: loaded.bytes,
          contentType: loaded.contentType,
          conversionId,
          ...(declaration.alternativeText === undefined
            ? {}
            : { alternativeText: declaration.alternativeText }),
        });
        return { result: "stored" as const, coverImage };
      },
    );
    if (outcome.result === "stored") {
      return outcome.coverImage;
    }

    missingCause = { reason: outcome.reason };
  } catch (error) {
    missingCause = { error };
  }

  try {
    await logOnce(
      step,
      ConversionPhase.SOURCE_MATERIAL_PREPARATION,
      "log missing cover image",
      () => logMissingCoverImage(conversionId, missingCause),
    );
  } catch {
    // A log step the engine could not run must not fail the conversion: this never rejects.
  }
  return undefined;
}

/**
 * Decides the narration language in one retryable step. Detection never rejects: when the step's
 * retries are exhausted, or the answer is unusable, it falls back to the declared language or to
 * none, and the fallback is logged. A narration language the speech model cannot speak stays the
 * narration language and is logged on its own, also when it came from a fallback; a speech provider
 * that ignores the narration language, such as ElevenLabs, logs nothing. Both warnings are logged
 * in one step, so a replay of the run does not log them again.
 */
async function detectNarrationLanguage({
  conversionId,
  detect,
  input,
  step,
}: {
  conversionId: string;
  detect: PrepareAudiobookWorkflowServices["detectNarrationLanguage"];
  input: NarrationLanguageDetectionInput;
  step: WorkflowStep;
}): Promise<NarrationLanguageDetectionResult> {
  const result = await detect(input, {
    conversionId,
    runDetection: (detectLanguage) =>
      step.do(
        phaseStepName(ConversionPhase.NARRATION_DOCUMENT_CREATION, "detect narration language"),
        AI_STEP_CONFIG,
        detectLanguage,
      ),
  });

  const { fallbackReason, narrationLanguage } = result;
  const isUnspeakable =
    narrationLanguage !== undefined &&
    getNarrationLanguageSupport(narrationLanguage, SPEECH_CONFIG) === "unspeakable";
  if (fallbackReason === undefined && !isUnspeakable) {
    return result;
  }

  await logOnce(
    step,
    ConversionPhase.NARRATION_DOCUMENT_CREATION,
    "log narration language warnings",
    () => {
      if (fallbackReason !== undefined) {
        logEvent(
          "narration-language-fallback",
          "Narration language detection fell back to the declared language or to none.",
          {
            attributes: {
              [TELEMETRY_ATTRIBUTES.CONVERSION_ID]: conversionId,
              [TELEMETRY_ATTRIBUTES.DECLARED_HTML_LANG]: input.declaredLanguage?.htmlLang,
              [TELEMETRY_ATTRIBUTES.DECLARED_OG_LOCALE]: input.declaredLanguage?.ogLocale,
              [TELEMETRY_ATTRIBUTES.NARRATION_LANGUAGE]: narrationLanguage,
              [TELEMETRY_ATTRIBUTES.NARRATION_LANGUAGE_FALLBACK_REASON]: fallbackReason,
            },
            ...(fallbackReason === "detector-error" ? { error: result.detectorError } : {}),
          },
        );
      }
      if (isUnspeakable) {
        logEvent(
          "narration-language-unspeakable",
          "The narration language is one the speech model cannot speak.",
          {
            attributes: {
              [TELEMETRY_ATTRIBUTES.CONVERSION_ID]: conversionId,
              [TELEMETRY_ATTRIBUTES.NARRATION_LANGUAGE]: narrationLanguage,
              "gen_ai.provider.name": SPEECH_CONFIG.provider,
              "gen_ai.request.model": SPEECH_CONFIG.model,
            },
          },
        );
      }
    },
  );
  return result;
}

/**
 * Runs `log` in a step of its own, which never retries. Code between steps runs again whenever the
 * engine replays the run, so a log record written there repeats; a replay reuses this step's
 * recorded result instead, so the record is written once.
 */
function logOnce(
  step: WorkflowStep,
  phase: ConversionPhase,
  description: string,
  log: () => void,
): Promise<void> {
  return step.do(phaseStepName(phase, description), PROCESSING_STEP_CONFIG, async () => {
    log();
  });
}

/** Either the loader's refusal reason or the error that ended the cover image step. */
type MissingCoverImageCause =
  | { reason: string; error?: never }
  | { reason?: never; error: unknown };

function logMissingCoverImage(conversionId: string, cause: MissingCoverImageCause) {
  logEvent(
    "cover-image-unavailable",
    "The declared cover image could not be stored; the audiobook goes without one.",
    {
      attributes: {
        [TELEMETRY_ATTRIBUTES.CONVERSION_ID]: conversionId,
        [TELEMETRY_ATTRIBUTES.COVER_IMAGE_REFUSAL_REASON]: cause.reason,
      },
      error: cause.error,
    },
  );
}

class ContentLimitError extends CupError {
  readonly narrationTextCharacters: number;
  readonly narrationChunks: number;

  constructor(narrationTextCharacters: number, narrationChunks: number) {
    super("Narration exceeds the conversion content ceiling");
    this.name = "ContentLimitError";
    this.narrationTextCharacters = narrationTextCharacters;
    this.narrationChunks = narrationChunks;
  }
}

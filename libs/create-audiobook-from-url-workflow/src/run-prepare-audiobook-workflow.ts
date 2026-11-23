import { captureException, uuid4 } from "@sentry/core";
import type { WorkflowEvent, WorkflowStep, WorkflowStepConfig } from "cloudflare:workers";
import { NonRetryableError } from "cloudflare:workflows";
import { Temporal } from "temporal-polyfill";

import {
  countNarrationTextCharactersBySegment,
  getNarrationLanguageSupport,
  SPEECH_CONFIG,
  storeAudiobook,
  storeAudiobookSourceMaterial,
  storeCoverImage,
  storeNarrationSourceMaterial,
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
import {
  CURRENT_SEGMENTATION_VERSION,
  segmentNarrationDocument,
} from "@cup/narration-document-creation";
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

      await step.do(
        phaseStepName(
          ConversionPhase.SOURCE_MATERIAL_PREPARATION,
          "store audiobook source material",
        ),
        PROCESSING_STEP_CONFIG,
        () =>
          storeAudiobookSourceMaterial({
            artifactPrefix,
            bucket,
            conversionId,
            html: sourceMaterial.html,
          }),
      );

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

      const segmentationVersion = CURRENT_SEGMENTATION_VERSION;
      const synchronizationUnits = await step.do(
        phaseStepName(
          ConversionPhase.NARRATION_DOCUMENT_CREATION,
          "segment narration source material",
        ),
        PROCESSING_STEP_CONFIG,
        async () => {
          await execution.phaseStarted(ConversionPhase.NARRATION_DOCUMENT_CREATION);
          return segmentNarrationDocument({
            segmentationVersion,
            sourceTitle: sourceMaterial.title,
            ...(sourceMaterial.subtitle === undefined
              ? {}
              : { sourceSubtitle: sourceMaterial.subtitle }),
            sourceMaterialHtml: selectedSourceMaterialHtml,
          }).synchronizationUnits;
        },
      );
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
          const narrationSourceMaterial = await storeNarrationSourceMaterial({
            artifactPrefix,
            bucket,
            conversionId,
            html: selectedSourceMaterialHtml,
          });
          return storeAudiobook({
            bucket,
            conversionId,
            artifactPrefix,
            title: sourceMaterial.title,
            originalUrl: sourceUrl,
            narrationDocument: {
              segmentationVersion,
              narrationSourceMaterial,
              fetchedUrl: sourceMaterial.fetchedUrl,
              ...(sourceMaterial.subtitle === undefined
                ? {}
                : { sourceSubtitle: sourceMaterial.subtitle }),
              synchronizationUnits,
            },
            speechConfig: SPEECH_CONFIG,
            ...(narrationLanguage === undefined ? {} : { narrationLanguage }),
            ...(coverImage === undefined ? {} : { coverImage }),
          });
        },
      );

      return {
        audiobookReference,
        narrationTextCharactersBySegment: countNarrationTextCharactersBySegment({
          synchronizationUnits,
        }),
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
      await coverImagePromise;

      const failedOutcome = await step.do(
        phaseStepName(ConversionPhase.FINALIZATION, "create failed conversion outcome"),
        PROCESSING_STEP_CONFIG,
        async () => {
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

  await step.do(
    phaseStepName(ConversionPhase.FINALIZATION, "start speech synthesis"),
    TERMINAL_STATE_STEP_CONFIG,
    async () => {
      await execution.startSynthesis(result.narrationTextCharactersBySegment);
    },
  );

  return result.audiobookReference;
}

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
      phaseStepName(ConversionPhase.SOURCE_MATERIAL_PREPARATION, "store cover image"),
      COVER_IMAGE_STEP_CONFIG,
      async () => {
        const loaded = await loadCoverImage(declaration, sourceUrl);
        if (loaded.result === "refused") {
          return loaded;
        }

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
  } catch {}
  return undefined;
}

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

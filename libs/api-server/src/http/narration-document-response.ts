import { captureException } from "@sentry/core";

import type {
  Audiobook as StoredAudiobook,
  NarrationSourceMaterialReference,
} from "@cup/audiobook-production";
import { CupError } from "@cup/errors";
import type { Audiobook } from "@cup/listener-api.routes";
import { renderNarrationDocument } from "@cup/narration-document-creation";
import { logEvent } from "@cup/telemetry.cloudflare";
import { TELEMETRY_ATTRIBUTES } from "@cup/telemetry.core";

type ReadyAudiobook = Extract<Audiobook, { status: "ready" }>;

/**
 * Renders the narration document a conversion's manifest stores into the listener response. A
 * render that fails, or disagrees with the stored units, still answers, with the fallback document,
 * and is reported to the operator.
 */
export async function toRenderedNarrationDocumentResponse({
  conversionId,
  audiobook,
  readNarrationSourceMaterial,
}: {
  conversionId: string;
  audiobook: Pick<StoredAudiobook, "narrationDocument" | "originalUrl" | "title">;
  readNarrationSourceMaterial: (reference: NarrationSourceMaterialReference) => Promise<string>;
}) {
  const { html, synchronizationUnits, mismatch, failure } = await renderNarrationDocument({
    narrationDocument: audiobook.narrationDocument,
    loadNarrationSourceMaterial: ({ narrationSourceMaterial }) =>
      readNarrationSourceMaterial(narrationSourceMaterial),
    originalUrl: audiobook.originalUrl,
    sourceTitle: audiobook.title,
  });

  if (failure !== undefined) {
    const message =
      "Rendering the narration document failed, so the listener got the fallback document.";

    captureException(new CupError(message, { cause: failure }), {
      tags: { [TELEMETRY_ATTRIBUTES.CONVERSION_ID]: conversionId },
    });
    logEvent("narration-document-render-failure", message, {
      attributes: { [TELEMETRY_ATTRIBUTES.CONVERSION_ID]: conversionId },
      error: failure,
    });
  }

  if (mismatch !== undefined) {
    const differingUnitId = mismatch.storedUnitId ?? mismatch.renderedUnitId;
    const message = `The rendered narration document disagrees with the stored synchronization units (${mismatch.reason} at unit ${mismatch.unitIndex}), so the listener got the fallback document.`;

    captureException(new CupError(message), {
      tags: {
        [TELEMETRY_ATTRIBUTES.CONVERSION_ID]: conversionId,
        [TELEMETRY_ATTRIBUTES.SYNCHRONIZATION_UNIT_ID]: differingUnitId,
      },
    });
    logEvent("narration-document-mismatch", message, {
      attributes: {
        [TELEMETRY_ATTRIBUTES.CONVERSION_ID]: conversionId,
        [TELEMETRY_ATTRIBUTES.SYNCHRONIZATION_UNIT_ID]: differingUnitId,
        [TELEMETRY_ATTRIBUTES.NARRATION_DOCUMENT_MISMATCH_REASON]: mismatch.reason,
      },
    });
  }

  return {
    html,
    synchronizationUnits: synchronizationUnits.map((unit) => ({
      id: unit.id,
      narrationText: unit.narrationText,
    })),
  } satisfies ReadyAudiobook["narrationDocument"];
}

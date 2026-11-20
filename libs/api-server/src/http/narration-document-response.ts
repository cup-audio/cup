import { captureException } from "@sentry/core";

import {
  loadNarrationSourceMaterial,
  type Audiobook as StoredAudiobook,
  type SourceMaterialStorage,
} from "@cup/audiobook-production";
import { CupError } from "@cup/errors";
import type { Audiobook } from "@cup/listener-api.routes";
import { renderNarrationDocument } from "@cup/narration-document-creation";
import { logEvent } from "@cup/telemetry.cloudflare";
import { TELEMETRY_ATTRIBUTES } from "@cup/telemetry.core";

type ReadyAudiobook = Extract<Audiobook, { status: "ready" }>;

/**
 * Renders the narration document a conversion's manifest stores into the listener response: an
 * existing conversion's stored HTML, or a new conversion's narration source material, read only
 * through the manifest's reference. A render that disagrees with the stored units still answers,
 * with the fallback document, and is reported to the operator.
 */
export async function toRenderedNarrationDocumentResponse({
  bucket,
  conversionId,
  audiobook,
}: {
  bucket: Pick<SourceMaterialStorage, "get">;
  conversionId: string;
  audiobook: Pick<StoredAudiobook, "narrationDocument" | "originalUrl" | "title">;
}) {
  const { narrationDocument, originalUrl } = audiobook;
  const { html, synchronizationUnits, mismatch } =
    "html" in narrationDocument
      ? renderNarrationDocument({ narrationDocument, originalUrl })
      : renderNarrationDocument({
          narrationDocument,
          narrationSourceMaterialHtml: await loadNarrationSourceMaterial({
            bucket,
            reference: narrationDocument.narrationSourceMaterial,
          }),
          originalUrl,
          sourceTitle: audiobook.title,
        });

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

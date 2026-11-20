import { captureException } from "@sentry/core";

import type { Audiobook as StoredAudiobook } from "@cup/audiobook-production";
import { CupError } from "@cup/errors";
import type { Audiobook } from "@cup/listener-api.routes";
import { renderNarrationDocument } from "@cup/narration-document-creation";
import { logEvent } from "@cup/telemetry.cloudflare";
import { TELEMETRY_ATTRIBUTES } from "@cup/telemetry.core";

type ReadyAudiobook = Extract<Audiobook, { status: "ready" }>;

/**
 * Renders the narration document a conversion's manifest stores into the listener response. A
 * render that disagrees with the stored units still answers, with the fallback document, and is
 * reported to the operator.
 */
export function toRenderedNarrationDocumentResponse({
  conversionId,
  audiobook,
}: {
  conversionId: string;
  audiobook: Pick<StoredAudiobook, "narrationDocument" | "originalUrl">;
}) {
  const { html, synchronizationUnits, mismatch } = renderNarrationDocument({
    narrationDocument: audiobook.narrationDocument,
    originalUrl: audiobook.originalUrl,
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

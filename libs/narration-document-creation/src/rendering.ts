import { presentStoredNarrationDocument } from "#src/existing-conversion-presentation.ts";
import { escapeHtmlText } from "#src/html-escaping.ts";
import { serializeUnitAttribute } from "#src/presentation-rules.ts";
import { presentNarrationDocument } from "#src/presentation.ts";
import { segmentNarrationDocument } from "#src/segmentation.ts";
import type { SegmentationVersion } from "#src/segmentation.ts";
import type { SynchronizationUnit } from "#src/synchronization-unit.ts";

export type RenderOptions<TNewConversion extends NewConversionNarrationDocument> = {
  narrationDocument: ExistingConversionNarrationDocument | TNewConversion;
  loadNarrationSourceMaterial: (narrationDocument: TNewConversion) => Promise<string>;
  originalUrl: string;
  sourceTitle: string;
};

export type ExistingConversionNarrationDocument = {
  html: string;
  synchronizationUnits: readonly SynchronizationUnit[];
};

export type NewConversionNarrationDocument = {
  segmentationVersion: SegmentationVersion;
  sourceSubtitle?: string | undefined;
  fetchedUrl?: string | undefined;
  synchronizationUnits: readonly SynchronizationUnit[];
};

export type RenderedNarrationDocument = {
  html: string;
  synchronizationUnits: readonly SynchronizationUnit[];
  mismatch?: NarrationDocumentMismatch;
  failure?: unknown;
};

export type NarrationDocumentMismatch = {
  reason: "missing-unit" | "narration-text" | "unexpected-unit" | "unit-id";
  unitIndex: number;
  storedUnitId?: string;
  renderedUnitId?: string;
};

export async function renderNarrationDocument<
  TNewConversion extends NewConversionNarrationDocument,
>({
  narrationDocument,
  loadNarrationSourceMaterial,
  originalUrl,
  sourceTitle,
}: RenderOptions<TNewConversion>): Promise<RenderedNarrationDocument> {
  const { synchronizationUnits } = narrationDocument;
  let rendered: { html: string; mismatch?: NarrationDocumentMismatch };

  try {
    rendered = isExistingConversion(narrationDocument)
      ? renderExistingConversion({ narrationDocument, originalUrl })
      : renderNewConversion({
          narrationDocument,
          narrationSourceMaterialHtml: await loadNarrationSourceMaterial(narrationDocument),
          originalUrl,
          sourceTitle,
        });
  } catch (error) {
    return {
      html: createFallbackDocument(synchronizationUnits),
      synchronizationUnits,
      failure: error,
    };
  }

  const { html, mismatch } = rendered;

  return mismatch === undefined
    ? { html, synchronizationUnits }
    : { html: createFallbackDocument(synchronizationUnits), synchronizationUnits, mismatch };
}

function isExistingConversion(
  narrationDocument: ExistingConversionNarrationDocument | NewConversionNarrationDocument,
): narrationDocument is ExistingConversionNarrationDocument {
  return "html" in narrationDocument;
}

function renderExistingConversion({
  narrationDocument,
  originalUrl,
}: {
  narrationDocument: ExistingConversionNarrationDocument;
  originalUrl: string;
}): { html: string; mismatch?: NarrationDocumentMismatch } {
  const { html, units } = presentStoredNarrationDocument({
    storedHtml: narrationDocument.html,
    baseUrl: originalUrl,
  });
  const mismatch = findFirstMismatch(
    narrationDocument.synchronizationUnits,
    units.map(({ id, text }) => ({ id, narrationText: text })),
    removeWhitespace,
  );

  return mismatch === undefined ? { html } : { html, mismatch };
}

function renderNewConversion({
  narrationDocument,
  narrationSourceMaterialHtml,
  originalUrl,
  sourceTitle,
}: {
  narrationDocument: NewConversionNarrationDocument;
  narrationSourceMaterialHtml: string;
  originalUrl: string;
  sourceTitle: string;
}): { html: string; mismatch?: NarrationDocumentMismatch } {
  const { segmentedDocument, synchronizationUnits } = segmentNarrationDocument({
    segmentationVersion: narrationDocument.segmentationVersion,
    sourceTitle,
    ...(narrationDocument.sourceSubtitle === undefined
      ? {}
      : { sourceSubtitle: narrationDocument.sourceSubtitle }),
    sourceMaterialHtml: narrationSourceMaterialHtml,
  });
  const mismatch = findFirstMismatch(
    narrationDocument.synchronizationUnits,
    synchronizationUnits,
    (text) => text,
  );

  if (mismatch !== undefined) {
    return { html: "", mismatch };
  }

  return {
    html: presentNarrationDocument({
      segmentedDocument,
      baseUrl: narrationDocument.fetchedUrl ?? originalUrl,
    }),
  };
}

function findFirstMismatch(
  storedUnits: readonly SynchronizationUnit[],
  renderedUnits: readonly SynchronizationUnit[],
  normalizeText: (text: string) => string,
): NarrationDocumentMismatch | undefined {
  for (
    let unitIndex = 0;
    unitIndex < Math.max(storedUnits.length, renderedUnits.length);
    unitIndex += 1
  ) {
    const storedUnit = storedUnits[unitIndex];
    const renderedUnit = renderedUnits[unitIndex];

    if (storedUnit === undefined) {
      return { reason: "unexpected-unit", unitIndex, renderedUnitId: renderedUnit!.id };
    }

    if (renderedUnit === undefined) {
      return { reason: "missing-unit", unitIndex, storedUnitId: storedUnit.id };
    }

    if (storedUnit.id !== renderedUnit.id) {
      return {
        reason: "unit-id",
        unitIndex,
        storedUnitId: storedUnit.id,
        renderedUnitId: renderedUnit.id,
      };
    }

    if (normalizeText(storedUnit.narrationText) !== normalizeText(renderedUnit.narrationText)) {
      return {
        reason: "narration-text",
        unitIndex,
        storedUnitId: storedUnit.id,
        renderedUnitId: renderedUnit.id,
      };
    }
  }

  return undefined;
}

function removeWhitespace(text: string): string {
  return text.replace(/\s+/gu, "");
}

function createFallbackDocument(synchronizationUnits: readonly SynchronizationUnit[]): string {
  const paragraphs = synchronizationUnits.map(
    ({ id, narrationText }) =>
      `<p${serializeUnitAttribute(id)}>${narrationText.split("\n").map(escapeHtmlText).join("<br>")}</p>`,
  );

  return `<article>${paragraphs.join("")}</article>`;
}

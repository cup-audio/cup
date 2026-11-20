import { presentStoredNarrationDocument } from "#src/existing-conversion-presentation.ts";
import { escapeHtmlText } from "#src/html-escaping.ts";
import { serializeUnitAttribute } from "#src/presentation-rules.ts";
import { presentNarrationDocument } from "#src/presentation.ts";
import { segmentNarrationDocument } from "#src/segmentation.ts";
import type { SegmentationVersion } from "#src/segmentation.ts";
import type { SynchronizationUnit } from "#src/synchronization-unit.ts";

/**
 * What a conversion's manifest stores to render its narration document, in one of two shapes, and
 * how to read a new conversion's narration source material, which the manifest only references.
 */
export type RenderOptions<TNewConversion extends NewConversionNarrationDocument> = {
  narrationDocument: ExistingConversionNarrationDocument | TNewConversion;
  /** Called only for a new conversion. */
  loadNarrationSourceMaterial: (narrationDocument: TNewConversion) => Promise<string>;
  /** The source URL the conversion was submitted with, the link base without a fetched URL. */
  originalUrl: string;
  sourceTitle: string;
};

/** An existing conversion stored the HTML narration document creation produced at preparation. */
export type ExistingConversionNarrationDocument = {
  html: string;
  synchronizationUnits: readonly SynchronizationUnit[];
};

/**
 * A new conversion stored its narration source material, and the segmentation version and units
 * preparation derived from it, so its narration document is segmented again on every render.
 */
export type NewConversionNarrationDocument = {
  segmentationVersion: SegmentationVersion;
  sourceSubtitle?: string | undefined;
  /** The fetched URL, against which relative links resolve. */
  fetchedUrl?: string | undefined;
  synchronizationUnits: readonly SynchronizationUnit[];
};

/** The narration document as the listener sees it, together with the stored units. */
export type RenderedNarrationDocument = {
  html: string;
  synchronizationUnits: readonly SynchronizationUnit[];
  /** Set when the render disagreed with the stored units, so `html` is the fallback document. */
  mismatch?: NarrationDocumentMismatch;
  /**
   * Set to what was thrown when loading, segmenting or presenting failed, so `html` is the fallback
   * document.
   */
  failure?: unknown;
};

/** The first unit at which a render disagreed with the stored units. */
export type NarrationDocumentMismatch = {
  reason: "missing-unit" | "narration-text" | "unexpected-unit" | "unit-id";
  /** The position, starting at 0, of the first differing unit. */
  unitIndex: number;
  /** The stored unit's ID at that position, absent when the render found more units than stored. */
  storedUnitId?: string;
  /** The rendered unit's ID at that position, absent when the render found fewer units. */
  renderedUnitId?: string;
};

/**
 * Renders a conversion's narration document from what its manifest stores, whose shape chooses the
 * path. Units are bound to paid audio and never change after preparation, so a render that fails or
 * disagrees with the stored units is replaced by the fallback document, built from the stored units
 * alone, and never rejects: the listener can still read, listen and see highlighting.
 */
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
  // Existing conversions' stored HTML and narration text normalized whitespace differently, for
  // example between a heading and the block it joined.
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

/** Compares stored and rendered units by order, ID, and narration text, after `normalizeText`. */
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

/** One paragraph per stored unit, holding its narration text with its line breaks. */
function createFallbackDocument(synchronizationUnits: readonly SynchronizationUnit[]): string {
  const paragraphs = synchronizationUnits.map(
    ({ id, narrationText }) =>
      `<p${serializeUnitAttribute(id)}>${narrationText.split("\n").map(escapeHtmlText).join("<br>")}</p>`,
  );

  return `<article>${paragraphs.join("")}</article>`;
}

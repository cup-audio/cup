import { presentStoredNarrationDocument } from "#src/existing-conversion-presentation.ts";
import { escapeHtmlAttribute, escapeHtmlText } from "#src/html-escaping.ts";
import { presentNarrationDocument } from "#src/presentation.ts";
import { segmentNarrationDocument } from "#src/segmentation.ts";
import type { SegmentationVersion } from "#src/segmentation.ts";
import type { SynchronizationUnit } from "#src/synchronization-unit.ts";

/** What a conversion's manifest stores to render its narration document. */
export type RenderOptions = ExistingConversionRenderOptions | NewConversionRenderOptions;

/** An existing conversion stored the HTML narration document creation produced at preparation. */
export type ExistingConversionRenderOptions = {
  narrationDocument: { html: string; synchronizationUnits: readonly SynchronizationUnit[] };
  /** The source URL the conversion was submitted with, against which relative links resolve. */
  originalUrl: string;
};

/**
 * A new conversion stored its narration source material, and the segmentation version and units
 * preparation derived from it, so its narration document is segmented again on every render.
 */
export type NewConversionRenderOptions = {
  narrationDocument: {
    segmentationVersion: SegmentationVersion;
    sourceSubtitle?: string | undefined;
    /** The URL the source page was finally loaded from, against which relative links resolve. */
    fetchedUrl?: string | undefined;
    synchronizationUnits: readonly SynchronizationUnit[];
  };
  narrationSourceMaterialHtml: string;
  /** The source URL the conversion was submitted with, the link base without a fetched URL. */
  originalUrl: string;
  sourceTitle: string;
};

/** The narration document as the listener sees it, together with the stored units. */
export type RenderedNarrationDocument = {
  html: string;
  synchronizationUnits: readonly SynchronizationUnit[];
  /** Set when the render disagreed with the stored units, so `html` is the fallback document. */
  mismatch?: NarrationDocumentMismatch;
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
 * Renders a conversion's narration document from what its manifest stores. Units are bound to paid
 * audio and never change after preparation, so a render that disagrees with the stored units is
 * replaced by the fallback document, built from the stored units alone, and never throws.
 */
export function renderNarrationDocument(options: RenderOptions): RenderedNarrationDocument {
  const { synchronizationUnits } = options.narrationDocument;
  const { html, mismatch } =
    "narrationSourceMaterialHtml" in options
      ? renderNewConversion(options)
      : renderExistingConversion(options);

  return mismatch === undefined
    ? { html, synchronizationUnits }
    : { html: createFallbackDocument(synchronizationUnits), synchronizationUnits, mismatch };
}

function renderExistingConversion({
  narrationDocument,
  originalUrl,
}: ExistingConversionRenderOptions): { html: string; mismatch?: NarrationDocumentMismatch } {
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
}: NewConversionRenderOptions): { html: string; mismatch?: NarrationDocumentMismatch } {
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

  // Until presentation marks units and resolves links itself, its HTML takes the shape of an
  // existing conversion's stored HTML, which the existing-conversion presentation turns into what
  // the reader expects.
  const { html } = presentStoredNarrationDocument({
    storedHtml: presentNarrationDocument(segmentedDocument),
    baseUrl: narrationDocument.fetchedUrl ?? originalUrl,
  });

  return { html };
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
      `<p data-synchronization-unit="${escapeHtmlAttribute(id)}">${narrationText.split("\n").map(escapeHtmlText).join("<br>")}</p>`,
  );

  return `<article>${paragraphs.join("")}</article>`;
}

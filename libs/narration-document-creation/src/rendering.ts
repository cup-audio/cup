import { presentStoredNarrationDocument } from "#src/existing-conversion-presentation.ts";
import type { PresentedUnit } from "#src/existing-conversion-presentation.ts";
import { escapeHtmlAttribute, escapeHtmlText } from "#src/html-escaping.ts";
import type { SynchronizationUnit } from "#src/synchronization-unit.ts";

/**
 * What a conversion's manifest stores to render its narration document. An existing conversion
 * stored the HTML narration document creation produced at preparation.
 */
export type RenderOptions = {
  narrationDocument: { html: string; synchronizationUnits: readonly SynchronizationUnit[] };
  /** The source URL the conversion was submitted with, against which relative links resolve. */
  originalUrl: string;
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
export function renderNarrationDocument({
  narrationDocument,
  originalUrl,
}: RenderOptions): RenderedNarrationDocument {
  const { synchronizationUnits } = narrationDocument;
  const { html, units } = presentStoredNarrationDocument({
    storedHtml: narrationDocument.html,
    baseUrl: originalUrl,
  });
  const mismatch = findFirstMismatch(synchronizationUnits, units);

  return mismatch === undefined
    ? { html, synchronizationUnits }
    : { html: createFallbackDocument(synchronizationUnits), synchronizationUnits, mismatch };
}

function findFirstMismatch(
  storedUnits: readonly SynchronizationUnit[],
  renderedUnits: readonly PresentedUnit[],
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

    // Existing conversions' stored HTML and narration text normalized whitespace differently, for
    // example between a heading and the block it joined.
    if (removeWhitespace(storedUnit.narrationText) !== removeWhitespace(renderedUnit.text)) {
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

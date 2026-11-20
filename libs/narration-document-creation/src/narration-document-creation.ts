import { presentNarrationDocument } from "#src/presentation.ts";
import { segmentNarrationDocument } from "#src/segmentation.ts";
import type { SynchronizationUnit } from "#src/synchronization-unit.ts";

export { presentNarrationDocument } from "#src/presentation.ts";
export { renderNarrationDocument } from "#src/rendering.ts";
export type {
  NarrationDocumentMismatch,
  RenderedNarrationDocument,
  ExistingConversionRenderOptions,
  NewConversionRenderOptions,
  RenderOptions,
} from "#src/rendering.ts";
export { segmentNarrationDocument } from "#src/segmentation.ts";
export type {
  NarrationBlock,
  SegmentationVersion,
  SegmentedDocument,
  SegmentOptions,
  UnitRange,
} from "#src/segmentation.ts";
export { SYNCHRONIZATION_UNIT_SCHEMA } from "#src/synchronization-unit.ts";
export type { SynchronizationUnit } from "#src/synchronization-unit.ts";

/** Safe structured text and ordered units used to produce synchronized outputs. */
export type NarrationDocument = {
  html: string;
  synchronizationUnits: readonly SynchronizationUnit[];
};

/**
 * Supplies the source title, optional source subtitle and selected HTML used to build a narration
 * document.
 */
export type CreateOptions = {
  sourceTitle: string;
  sourceSubtitle?: string;
  sourceMaterialHtml: string;
};

/**
 * Creates safe display HTML and matching paragraph-oriented synchronization units, by segmenting
 * the source material with segmentation version 1 and presenting the segmented document.
 */
export function createNarrationDocument(options: CreateOptions): NarrationDocument {
  const { segmentedDocument, synchronizationUnits } = segmentNarrationDocument({
    ...options,
    segmentationVersion: 1,
  });

  return { html: presentNarrationDocument(segmentedDocument), synchronizationUnits };
}

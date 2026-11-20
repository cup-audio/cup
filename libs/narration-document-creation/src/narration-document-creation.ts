export { renderNarrationDocument } from "#src/rendering.ts";
export type {
  NarrationDocumentMismatch,
  RenderedNarrationDocument,
  ExistingConversionRenderOptions,
  NewConversionRenderOptions,
  RenderOptions,
} from "#src/rendering.ts";
export { CURRENT_SEGMENTATION_VERSION, segmentNarrationDocument } from "#src/segmentation.ts";
export type {
  NarrationBlock,
  SegmentationVersion,
  SegmentedDocument,
  SegmentOptions,
  UnitRange,
} from "#src/segmentation.ts";
export { SYNCHRONIZATION_UNIT_SCHEMA } from "#src/synchronization-unit.ts";
export type { SynchronizationUnit } from "#src/synchronization-unit.ts";

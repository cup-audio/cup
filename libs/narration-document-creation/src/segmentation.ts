import { parseFragment } from "parse5";
import type { DefaultTreeAdapterMap } from "parse5";

import { segmentWithVersion1 } from "#src/segmentation-version-1/segmentation-version-1.ts";
import type { SynchronizationUnit } from "#src/synchronization-unit.ts";

/** A numbered set of segmentation rules, decided once when a conversion is prepared. */
export type SegmentationVersion = 1;

/** Supplies the narration source material and the segmentation version to segment it with. */
export type SegmentOptions = {
  segmentationVersion: SegmentationVersion;
  sourceTitle: string;
  sourceSubtitle?: string;
  sourceMaterialHtml: string;
};

/**
 * The fully parsed narration source material, with every element and attribute kept, together with
 * every synchronization unit and its range in it. Presentation turns it into HTML.
 */
export type SegmentedDocument = {
  segmentationVersion: SegmentationVersion;
  sourceTitle: string;
  sourceSubtitle?: string;
  sourceMaterial: DefaultTreeAdapterMap["documentFragment"];
  unitRanges: readonly UnitRange[];
};

/** One synchronization unit and where it sits in the segmented document, in unit order. */
export type UnitRange = {
  synchronizationUnit: SynchronizationUnit;
} & (
  | { type: "source-title" }
  | { type: "source-subtitle" }
  | {
      /** Zero or more headings followed by the block they join. */
      type: "body";
      blocks: readonly NarrationBlock[];
      /**
       * The unit's part of a split block, as offsets into the blocks' narration texts joined by a
       * blank line. It is absent when the unit covers its blocks whole.
       */
      textRange?: { start: number; end: number };
    }
  | {
      /** Headings that no block followed at the end of the source material. */
      type: "trailing-headings";
      blocks: readonly NarrationBlock[];
      /** Whether the headings were split into several units, each holding part of their text. */
      isSplit: boolean;
    }
);

/**
 * A heading or paragraph element of the source material, or a run of text and inline nodes that
 * sits directly in a container and is shown as its own paragraph.
 */
export type NarrationBlock =
  | { type: "element"; element: DefaultTreeAdapterMap["element"] }
  | { type: "inline-run"; nodes: readonly DefaultTreeAdapterMap["childNode"][] };

/** Divides narration source material into synchronization units with the given version's rules. */
export function segmentNarrationDocument({
  segmentationVersion,
  sourceTitle,
  sourceSubtitle,
  sourceMaterialHtml,
}: SegmentOptions): {
  segmentedDocument: SegmentedDocument;
  synchronizationUnits: readonly SynchronizationUnit[];
} {
  const sourceMaterial = parseFragment(sourceMaterialHtml);
  const segmentation = segmentWithVersion1({ sourceTitle, sourceSubtitle, sourceMaterial });

  return {
    segmentedDocument: {
      segmentationVersion,
      sourceTitle: segmentation.sourceTitle,
      ...(segmentation.sourceSubtitle === undefined
        ? {}
        : { sourceSubtitle: segmentation.sourceSubtitle }),
      sourceMaterial,
      unitRanges: segmentation.unitRanges,
    },
    synchronizationUnits: segmentation.unitRanges.map((unitRange) => unitRange.synchronizationUnit),
  };
}

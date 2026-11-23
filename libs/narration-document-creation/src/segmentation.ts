import { parseFragment } from "parse5";
import type { DefaultTreeAdapterMap } from "parse5";

import { segmentWithVersion1 } from "#src/segmentation-version-1/segmentation-version-1.ts";
import { segmentWithVersion2 } from "#src/segmentation-version-2/segmentation-version-2.ts";
import type { SynchronizationUnit } from "#src/synchronization-unit.ts";

export type SegmentationVersion = 1 | 2;

export const CURRENT_SEGMENTATION_VERSION = 2 satisfies SegmentationVersion;

export type SegmentOptions = {
  segmentationVersion: SegmentationVersion;
  sourceTitle: string;
  sourceSubtitle?: string;
  sourceMaterialHtml: string;
};

export type SegmentedDocument = {
  segmentationVersion: SegmentationVersion;
  sourceTitle: string;
  sourceSubtitle?: string;
  sourceMaterial: DefaultTreeAdapterMap["documentFragment"];
  unitRanges: readonly UnitRange[];
};

export type UnitRange = {
  synchronizationUnit: SynchronizationUnit;
} & (
  | { type: "source-title" }
  | { type: "source-subtitle" }
  | {
      type: "body";
      blocks: readonly NarrationBlock[];
      textRange?: { start: number; end: number };
    }
  | {
      type: "trailing-headings";
      blocks: readonly NarrationBlock[];
      isSplit: boolean;
    }
);

export type NarrationBlock =
  | { type: "element"; element: DefaultTreeAdapterMap["element"] }
  | { type: "inline-run"; nodes: readonly DefaultTreeAdapterMap["childNode"][] };

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
  const segmentation = (segmentationVersion === 1 ? segmentWithVersion1 : segmentWithVersion2)({
    sourceTitle,
    sourceSubtitle,
    sourceMaterial,
  });

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

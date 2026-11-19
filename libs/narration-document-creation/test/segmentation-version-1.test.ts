import fs from "node:fs";
import path from "node:path";
import { expect, test } from "vitest";

import { createNarrationDocument } from "#src/narration-document-creation.ts";
import type { SynchronizationUnit } from "#src/narration-document-creation.ts";

type SegmentationFixture = {
  sourceTitle: string;
  sourceSubtitle?: string;
  sourceMaterialHtml: string;
  synchronizationUnits: SynchronizationUnit[];
};

// The expected units were generated from createNarrationDocument before segmentation was split out
// of it, and are frozen: a change that alters them must become a new segmentation version.
const FIXTURES_DIRECTORY = path.join(import.meta.dirname, "fixtures/segmentation-version-1");

const FIXTURE_FILE_NAMES = fs
  .readdirSync(FIXTURES_DIRECTORY)
  .filter((fileName) => fileName.endsWith(".json"))
  .toSorted();

test("covers every committed segmentation version 1 golden fixture", () => {
  expect(FIXTURE_FILE_NAMES).toEqual([
    "block-split-into-several-units.json",
    "description-list.json",
    "heading-before-each-container.json",
    "nested-lists-and-blockquotes.json",
    "paragraphs-and-headings.json",
    "preformatted-text.json",
    "source-title-and-subtitle.json",
    "source-title-without-subtitle.json",
    "table-cells-and-caption.json",
  ]);
});

test.for(FIXTURE_FILE_NAMES)("segmentation version 1 keeps the units of %s", (fileName) => {
  const { synchronizationUnits, ...input } = JSON.parse(
    fs.readFileSync(path.join(FIXTURES_DIRECTORY, fileName), "utf8"),
  ) as SegmentationFixture;

  expect(createNarrationDocument(input).synchronizationUnits).toEqual(synchronizationUnits);
});

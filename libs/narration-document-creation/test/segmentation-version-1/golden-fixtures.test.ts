import fs from "node:fs";
import path from "node:path";
import { expect, test } from "vitest";
import { z } from "zod";

import { segmentNarrationDocument, SYNCHRONIZATION_UNIT_SCHEMA } from "#src/index.ts";

const SEGMENTATION_FIXTURE_SCHEMA = z
  .object({
    sourceTitle: z.string(),
    sourceSubtitle: z.string().exactOptional(),
    sourceMaterialHtml: z.string(),
    synchronizationUnits: z.array(SYNCHRONIZATION_UNIT_SCHEMA),
  })
  .strict();

// The expected units were generated from createNarrationDocument before segmentation was split out
// of it, and are frozen: a change that alters them must become a new segmentation version.
const FIXTURES_DIRECTORY = path.join(import.meta.dirname, "golden-fixtures");

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
  const { synchronizationUnits, ...input } = SEGMENTATION_FIXTURE_SCHEMA.parse(
    JSON.parse(fs.readFileSync(path.join(FIXTURES_DIRECTORY, fileName), "utf8")),
  );

  expect(
    segmentNarrationDocument({ ...input, segmentationVersion: 1 }).synchronizationUnits,
  ).toEqual(synchronizationUnits);
});

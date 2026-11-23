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

const FIXTURES_DIRECTORY = path.join(import.meta.dirname, "golden-fixtures");

const FIXTURE_FILE_NAMES = fs
  .readdirSync(FIXTURES_DIRECTORY)
  .filter((fileName) => fileName.endsWith(".json"))
  .toSorted();

test("covers every committed segmentation version 2 golden fixture", () => {
  expect(FIXTURE_FILE_NAMES).toEqual([
    "block-split-into-several-units.json",
    "description-list-groups.json",
    "heading-before-each-container.json",
    "nested-lists-and-blockquotes.json",
    "oversized-rows-and-lines.json",
    "paragraphs-and-headings.json",
    "preformatted-text.json",
    "source-title-and-subtitle.json",
    "source-title-without-subtitle.json",
    "table-rows-and-caption.json",
    "table-without-header-row.json",
  ]);
});

test.for(FIXTURE_FILE_NAMES)("segmentation version 2 keeps the units of %s", (fileName) => {
  const { synchronizationUnits, ...input } = SEGMENTATION_FIXTURE_SCHEMA.parse(
    JSON.parse(fs.readFileSync(path.join(FIXTURES_DIRECTORY, fileName), "utf8")),
  );

  expect(
    segmentNarrationDocument({ ...input, segmentationVersion: 2 }).synchronizationUnits,
  ).toEqual(synchronizationUnits);
});

import fs from "node:fs";
import path from "node:path";
import { expect, test } from "vitest";
import { z } from "zod";

import { renderNarrationDocument, SYNCHRONIZATION_UNIT_SCHEMA } from "#src/index.ts";

const EXISTING_CONVERSION_FIXTURE_SCHEMA = z
  .object({
    description: z.string(),
    originalUrl: z.string(),
    storedHtml: z.string(),
    synchronizationUnits: z.array(SYNCHRONIZATION_UNIT_SCHEMA),
    expectedHtml: z.string(),
  })
  .strict();

const FIXTURES_DIRECTORY = path.join(import.meta.dirname, "golden-fixtures");
const WITHOUT_NARRATION_SOURCE_MATERIAL = {
  sourceTitle: "Title",
  loadNarrationSourceMaterial: async () => {
    throw new Error("An existing conversion has no narration source material to load.");
  },
};

const FIXTURE_FILE_NAMES = fs
  .readdirSync(FIXTURES_DIRECTORY)
  .filter((fileName) => fileName.endsWith(".json"))
  .toSorted();

test("covers every committed existing-conversion golden fixture", async () => {
  expect(FIXTURE_FILE_NAMES).toEqual([
    "before-hgroup.json",
    "block-split-into-several-units.json",
    "heading-inside-a-container.json",
    "section-wrappers.json",
    "speech-policy-7.json",
    "with-hgroup.json",
  ]);
});

test.for(FIXTURE_FILE_NAMES)("renders the stored HTML of %s", async (fileName) => {
  const { originalUrl, storedHtml, synchronizationUnits, expectedHtml } =
    EXISTING_CONVERSION_FIXTURE_SCHEMA.parse(
      JSON.parse(fs.readFileSync(path.join(FIXTURES_DIRECTORY, fileName), "utf8")),
    );

  expect(
    await renderNarrationDocument({
      narrationDocument: { html: storedHtml, synchronizationUnits },
      originalUrl,
      ...WITHOUT_NARRATION_SOURCE_MATERIAL,
    }),
  ).toEqual({ html: expectedHtml, synchronizationUnits });
});

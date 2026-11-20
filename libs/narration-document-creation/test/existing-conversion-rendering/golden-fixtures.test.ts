import fs from "node:fs";
import path from "node:path";
import { expect, test } from "vitest";
import { z } from "zod";

import {
  renderNarrationDocument,
  SYNCHRONIZATION_UNIT_SCHEMA,
} from "#src/narration-document-creation.ts";

const EXISTING_CONVERSION_FIXTURE_SCHEMA = z
  .object({
    description: z.string(),
    originalUrl: z.string(),
    storedHtml: z.string(),
    synchronizationUnits: z.array(SYNCHRONIZATION_UNIT_SCHEMA),
    expectedHtml: z.string(),
  })
  .strict();

// Each fixture's stored HTML and units were produced by createNarrationDocument as it was when a
// historical shape was written, so the existing-conversion path keeps rendering every audiobook
// prepared before the narration document was rendered on request.
const FIXTURES_DIRECTORY = path.join(import.meta.dirname, "golden-fixtures");

const FIXTURE_FILE_NAMES = fs
  .readdirSync(FIXTURES_DIRECTORY)
  .filter((fileName) => fileName.endsWith(".json"))
  .toSorted();

test("covers every committed existing-conversion golden fixture", () => {
  expect(FIXTURE_FILE_NAMES).toEqual([
    "before-hgroup.json",
    "block-split-into-several-units.json",
    "heading-inside-a-container.json",
    "section-wrappers.json",
    "speech-policy-7.json",
    "with-hgroup.json",
  ]);
});

test.for(FIXTURE_FILE_NAMES)("renders the stored HTML of %s", (fileName) => {
  const { originalUrl, storedHtml, synchronizationUnits, expectedHtml } =
    EXISTING_CONVERSION_FIXTURE_SCHEMA.parse(
      JSON.parse(fs.readFileSync(path.join(FIXTURES_DIRECTORY, fileName), "utf8")),
    );

  expect(
    renderNarrationDocument({
      narrationDocument: { html: storedHtml, synchronizationUnits },
      originalUrl,
    }),
  ).toEqual({ html: expectedHtml, synchronizationUnits });
});

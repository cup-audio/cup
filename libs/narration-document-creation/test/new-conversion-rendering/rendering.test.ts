import { expect, test } from "vitest";

import { renderNarrationDocument } from "#src/index.ts";

const ORIGINAL_URL = "https://publisher.example/submitted/story";
const FETCHED_URL = "https://www.publisher.example/articles/story";
const SOURCE_TITLE = "Story title";
const NARRATION_SOURCE_MATERIAL_HTML =
  '<p>First <a href="../about">paragraph</a>.</p><h2>Heading</h2><p>Second <span>&amp; last</span> paragraph.</p>';
const STORED_UNITS = [
  { id: "narration-unit-0001", narrationText: "Story title" },
  { id: "narration-unit-0002", narrationText: "A subtitle" },
  { id: "narration-unit-0003", narrationText: "First paragraph." },
  { id: "narration-unit-0004", narrationText: "Heading\n\nSecond & last paragraph." },
];

test("renders a new conversion's narration document from its narration source material, with links resolved against the fetched URL", async () => {
  expect(
    await renderNarrationDocument({
      narrationDocument: {
        segmentationVersion: 1,
        sourceSubtitle: "A subtitle",
        fetchedUrl: FETCHED_URL,
        synchronizationUnits: STORED_UNITS,
      },
      loadNarrationSourceMaterial: async () => NARRATION_SOURCE_MATERIAL_HTML,
      originalUrl: ORIGINAL_URL,
      sourceTitle: SOURCE_TITLE,
    }),
  ).toEqual({
    html: '<article><hgroup><h1 data-synchronization-unit="narration-unit-0001">Story title</h1><p data-synchronization-unit="narration-unit-0002">A subtitle</p></hgroup><p data-synchronization-unit="narration-unit-0003">First <a href="https://www.publisher.example/about">paragraph</a>.</p><h2 data-synchronization-unit="narration-unit-0004">Heading</h2><p data-synchronization-unit="narration-unit-0004">Second &amp; last paragraph.</p></article>',
    synchronizationUnits: STORED_UNITS,
  });
});

test("resolves a new conversion's links against the submitted source URL when no fetched URL is stored", async () => {
  const { html, mismatch } = await renderNarrationDocument({
    narrationDocument: {
      segmentationVersion: 1,
      synchronizationUnits: [STORED_UNITS[0]!, STORED_UNITS[2]!].map((unit, unitIndex) => ({
        ...unit,
        id: `narration-unit-000${unitIndex + 1}`,
      })),
    },
    loadNarrationSourceMaterial: async () => '<p>First <a href="../about">paragraph</a>.</p>',
    originalUrl: ORIGINAL_URL,
    sourceTitle: SOURCE_TITLE,
  });

  expect(mismatch).toBeUndefined();
  expect(html).toContain('<a href="https://publisher.example/about">paragraph</a>');
});

test("serves the fallback document when a new conversion's units differ from its stored units only in whitespace", async () => {
  const synchronizationUnits = [
    ...STORED_UNITS.slice(0, 3),
    { id: "narration-unit-0004", narrationText: "Heading\nSecond & last paragraph." },
  ];

  expect(
    await renderNarrationDocument({
      narrationDocument: {
        segmentationVersion: 1,
        sourceSubtitle: "A subtitle",
        fetchedUrl: FETCHED_URL,
        synchronizationUnits,
      },
      loadNarrationSourceMaterial: async () => NARRATION_SOURCE_MATERIAL_HTML,
      originalUrl: ORIGINAL_URL,
      sourceTitle: SOURCE_TITLE,
    }),
  ).toEqual({
    html: '<article><p data-synchronization-unit="narration-unit-0001">Story title</p><p data-synchronization-unit="narration-unit-0002">A subtitle</p><p data-synchronization-unit="narration-unit-0003">First paragraph.</p><p data-synchronization-unit="narration-unit-0004">Heading<br>Second &amp; last paragraph.</p></article>',
    synchronizationUnits,
    mismatch: {
      reason: "narration-text",
      unitIndex: 3,
      storedUnitId: "narration-unit-0004",
      renderedUnitId: "narration-unit-0004",
    },
  });
});

test("serves the fallback document when a new conversion's stored units no longer match its source subtitle", async () => {
  expect(
    (
      await renderNarrationDocument({
        narrationDocument: {
          segmentationVersion: 1,
          fetchedUrl: FETCHED_URL,
          synchronizationUnits: STORED_UNITS,
        },
        loadNarrationSourceMaterial: async () => NARRATION_SOURCE_MATERIAL_HTML,
        originalUrl: ORIGINAL_URL,
        sourceTitle: SOURCE_TITLE,
      })
    ).mismatch,
  ).toEqual({
    reason: "narration-text",
    unitIndex: 1,
    storedUnitId: "narration-unit-0002",
    renderedUnitId: "narration-unit-0002",
  });
});

test("serves the fallback document and reports the failure when a new conversion's narration source material can't be loaded", async () => {
  const loadFailure = new Error("Narration source material was not found in storage");

  expect(
    await renderNarrationDocument({
      narrationDocument: {
        segmentationVersion: 1,
        sourceSubtitle: "A subtitle",
        fetchedUrl: FETCHED_URL,
        synchronizationUnits: STORED_UNITS,
      },
      loadNarrationSourceMaterial: async () => {
        throw loadFailure;
      },
      originalUrl: ORIGINAL_URL,
      sourceTitle: SOURCE_TITLE,
    }),
  ).toEqual({
    html: '<article><p data-synchronization-unit="narration-unit-0001">Story title</p><p data-synchronization-unit="narration-unit-0002">A subtitle</p><p data-synchronization-unit="narration-unit-0003">First paragraph.</p><p data-synchronization-unit="narration-unit-0004">Heading<br><br>Second &amp; last paragraph.</p></article>',
    synchronizationUnits: STORED_UNITS,
    failure: loadFailure,
  });
});

test("serves the fallback document and reports the failure when segmentation throws", async () => {
  const rendered = await renderNarrationDocument({
    narrationDocument: {
      segmentationVersion: 2,
      sourceSubtitle: "A subtitle",
      synchronizationUnits: STORED_UNITS,
    },
    loadNarrationSourceMaterial: async () => NARRATION_SOURCE_MATERIAL_HTML,
    originalUrl: ORIGINAL_URL,
    sourceTitle: " ",
  });

  expect(rendered.html).toContain(
    '<p data-synchronization-unit="narration-unit-0001">Story title</p>',
  );
  expect(rendered.failure).toEqual(
    expect.objectContaining({ message: "Expected the source title to contain narration text" }),
  );
  expect(rendered.mismatch).toBeUndefined();
});

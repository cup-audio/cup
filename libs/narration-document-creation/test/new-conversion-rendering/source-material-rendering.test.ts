import { expect, test } from "vitest";

import {
  renderNarrationDocument,
  segmentNarrationDocument,
  SYNCHRONIZATION_UNIT_SCHEMA,
} from "#src/index.ts";

/**
 * Segments narration source material with segmentation version 1 and renders it as a new conversion
 * whose stored units are the derived ones, as preparation and the listener API do.
 */
async function renderSourceMaterial(options: {
  sourceTitle: string;
  sourceSubtitle?: string;
  sourceMaterialHtml: string;
}) {
  const { synchronizationUnits } = segmentNarrationDocument({ ...options, segmentationVersion: 1 });
  const { html, mismatch } = await renderNarrationDocument({
    narrationDocument: {
      segmentationVersion: 1,
      sourceSubtitle: options.sourceSubtitle,
      synchronizationUnits,
    },
    loadNarrationSourceMaterial: async () => options.sourceMaterialHtml,
    originalUrl: "https://publisher.example/articles/story",
    sourceTitle: options.sourceTitle,
  });

  expect(mismatch).toBeUndefined();

  return { html, synchronizationUnits };
}

test("creates deterministic synchronization units from document-style HTML", async () => {
  const options = {
    sourceTitle: "A Source Title",
    sourceMaterialHtml: `
      <main data-tracking-id="source">
        <h1>A Source Title</h1>
        <p>The first <em>paragraph</em>.</p>
        <h2>A section</h2>
        <p>The second <strong>paragraph</strong>.</p>
      </main>
    `,
  };

  const narrationDocument = await renderSourceMaterial(options);

  expect(narrationDocument).toEqual({
    html: '<article><h1 data-synchronization-unit="narration-unit-0001">A Source Title</h1><p data-synchronization-unit="narration-unit-0002">The first <em>paragraph</em>.</p><h2 data-synchronization-unit="narration-unit-0003">A section</h2><p data-synchronization-unit="narration-unit-0003">The second <strong>paragraph</strong>.</p></article>',
    synchronizationUnits: [
      { id: "narration-unit-0001", narrationText: "A Source Title" },
      { id: "narration-unit-0002", narrationText: "The first paragraph." },
      {
        id: "narration-unit-0003",
        narrationText: "A section\n\nThe second paragraph.",
      },
    ],
  });
  expect(await renderSourceMaterial(options)).toEqual(narrationDocument);
});

test("suppresses an equivalent source heading despite source-formatting whitespace", async () => {
  const narrationDocument = await renderSourceMaterial({
    sourceTitle: "A heading wrapped onto two lines",
    sourceMaterialHtml: `<h1>A heading wrapped onto\ntwo lines</h1><p>Body.</p>`,
  });

  expect(narrationDocument.synchronizationUnits.map(({ narrationText }) => narrationText)).toEqual([
    "A heading wrapped onto two lines",
    "Body.",
  ]);
  expect(narrationDocument.html.match(/A heading wrapped onto two lines/gu)).toHaveLength(1);
});

test("retains only safe document structure, attributes, and links", async () => {
  const narrationDocument = await renderSourceMaterial({
    sourceTitle: "Safe document",
    sourceMaterialHtml: `
      <div class="layout" onclick="track()">
        <blockquote cite="https://ignored.example">
          <p lang="en" class="body">
            Quote with <a href="https://example.com/source" target="_blank">a link</a>,
            <a href="/related">a relative link</a>,
            <a href="javascript:alert('no')">an unsafe link</a>, and an image
            <img src="tracking.gif" onerror="track()" alt="tracking text">.
            <script>secret()</script>
          </p>
        </blockquote>
        <h2>A list</h2>
        <ol reversed>
          <li>First <code>item</code>.</li>
          <li>Second item.</li>
        </ol>
      </div>
    `,
  });

  expect(narrationDocument.html).toBe(
    '<article><h1 data-synchronization-unit="narration-unit-0001">Safe document</h1><blockquote><p data-synchronization-unit="narration-unit-0002">Quote with <a href="https://example.com/source">a link</a>, <a href="https://publisher.example/related">a relative link</a>, an unsafe link, and an image .</p></blockquote><h2 data-synchronization-unit="narration-unit-0003">A list</h2><ol><li><p data-synchronization-unit="narration-unit-0003">First <code>item</code>.</p></li><li><p data-synchronization-unit="narration-unit-0004">Second item.</p></li></ol></article>',
  );
  expect(narrationDocument.synchronizationUnits.map(({ narrationText }) => narrationText)).toEqual([
    "Safe document",
    "Quote with a link, a relative link, an unsafe link, and an image .",
    "A list\n\nFirst item.",
    "Second item.",
  ]);
  expect(narrationDocument.html).not.toMatch(/class|onclick|javascript:|script|img|target/iu);
});

test("preserves explicit line breaks and flattens nested generic element boundaries", async () => {
  const narrationDocument = await renderSourceMaterial({
    sourceTitle: "Structured whitespace",
    sourceMaterialHtml: `<p>Before<br>After <custom-inline>the boundary</custom-inline>.</p>`,
  });

  expect(narrationDocument).toEqual({
    html: '<article><h1 data-synchronization-unit="narration-unit-0001">Structured whitespace</h1><p data-synchronization-unit="narration-unit-0002">Before<br>After the boundary.</p></article>',
    synchronizationUnits: [
      { id: "narration-unit-0001", narrationText: "Structured whitespace" },
      { id: "narration-unit-0002", narrationText: "Before\nAfter the boundary." },
    ],
  });
});

test("retains structural wrappers when an oversized paragraph becomes multiple units", async () => {
  const paragraphText = Array.from({ length: 500 }, (_, index) => `word${index + 1}`).join(" ");
  const narrationDocument = await renderSourceMaterial({
    sourceTitle: "A long document",
    sourceMaterialHtml: `<blockquote data-source-id="42"><p>${paragraphText}</p></blockquote>`,
  });
  const paragraphUnits = narrationDocument.synchronizationUnits.slice(1);

  expect(paragraphUnits).toHaveLength(2);
  expect(paragraphUnits.every(({ narrationText }) => narrationText.length <= 2_000)).toBe(true);
  expect(paragraphUnits.map(({ narrationText }) => narrationText).join(" ")).toBe(paragraphText);

  for (const { id, narrationText } of paragraphUnits) {
    expect(narrationDocument.html).toContain(
      `<p data-synchronization-unit="${id}">${narrationText}</p>`,
    );
    expect(
      narrationDocument.html.match(new RegExp(`data-synchronization-unit="${id}"`, "gu")),
    ).toHaveLength(1);
  }

  expect(narrationDocument.html).toContain(
    `<blockquote>${paragraphUnits.map(({ id, narrationText }) => `<p data-synchronization-unit="${id}">${narrationText}</p>`).join("")}</blockquote>`,
  );
  expect(narrationDocument.html).not.toContain("data-source-id");
});

test("keeps a final heading as structured text and excludes non-content subtrees", async () => {
  const narrationDocument = await renderSourceMaterial({
    sourceTitle: "Heading document",
    sourceMaterialHtml: `
      <script><p>Script text.</p></script>
      <template><p>Template text.</p></template>
      <svg><text>SVG text.</text></svg>
      <h2>A final heading</h2>
    `,
  });

  expect(narrationDocument).toEqual({
    html: '<article><h1 data-synchronization-unit="narration-unit-0001">Heading document</h1><h2 data-synchronization-unit="narration-unit-0002">A final heading</h2></article>',
    synchronizationUnits: [
      { id: "narration-unit-0001", narrationText: "Heading document" },
      { id: "narration-unit-0002", narrationText: "A final heading" },
    ],
  });
});

test("preserves generic block boundaries and suppresses a matching source heading", async () => {
  const narrationDocument = await renderSourceMaterial({
    sourceTitle: "The source title",
    sourceMaterialHtml: `
      <div>Source summary.</div>
      <h2>The source title</h2>
      <custom-block>First generic block.</custom-block>
      <custom-block>Second generic block.</custom-block>
    `,
  });

  expect(narrationDocument.synchronizationUnits.map(({ narrationText }) => narrationText)).toEqual([
    "The source title",
    "Source summary.",
    "First generic block.",
    "Second generic block.",
  ]);
  expect(narrationDocument.html.match(/The source title/gu)).toHaveLength(1);
});

test("groups units by their original structural containers", async () => {
  const narrationDocument = await renderSourceMaterial({
    sourceTitle: "Lists",
    sourceMaterialHtml: `
      <ol><li><p>First paragraph.</p><p>Second paragraph.</p></li></ol>
      <ol><li>Another list.</li></ol>
    `,
  });

  expect(narrationDocument.html).toBe(
    '<article><h1 data-synchronization-unit="narration-unit-0001">Lists</h1><ol><li><p data-synchronization-unit="narration-unit-0002">First paragraph.</p><p data-synchronization-unit="narration-unit-0003">Second paragraph.</p></li></ol><ol><li><p data-synchronization-unit="narration-unit-0004">Another list.</p></li></ol></article>',
  );
});

test("preserves headings and inline markup across oversized synchronization units", async () => {
  const paragraphText = Array.from({ length: 500 }, (_, index) => `word${index + 1}`).join(" ");
  const narrationDocument = await renderSourceMaterial({
    sourceTitle: "Marked-up document",
    sourceMaterialHtml: `<h2>A long section</h2><p><em>${paragraphText}</em></p>`,
  });

  expect(narrationDocument.synchronizationUnits).toHaveLength(3);
  expect(narrationDocument.html).toContain(
    '<h2 data-synchronization-unit="narration-unit-0002">A long section</h2>',
  );
  expect(narrationDocument.html.match(/<em>/gu)).toHaveLength(2);
  expect(
    narrationDocument.synchronizationUnits
      .slice(1)
      .map(({ narrationText }) => narrationText)
      .join(" "),
  ).toBe(`A long section\n\n${paragraphText}`);
});

test("ignores HTML formatting whitespace while preserving explicit breaks", async () => {
  const sourceTitle = "Whitespace";
  const compactHtml =
    "<p>During my life I played a role in <em>developing software</em>.<br>After the break.</p>";
  const formattedHtml = `<p>
    During my life I played a role in
    <em>developing
    software</em>.<br>
    After the break.
  </p>`;
  const compactDocument = await renderSourceMaterial({
    sourceTitle,
    sourceMaterialHtml: compactHtml,
  });

  expect(await renderSourceMaterial({ sourceTitle, sourceMaterialHtml: formattedHtml })).toEqual(
    compactDocument,
  );
  expect(compactDocument.html).toBe(
    '<article><h1 data-synchronization-unit="narration-unit-0001">Whitespace</h1><p data-synchronization-unit="narration-unit-0002">During my life I played a role in <em>developing software</em>.<br>After the break.</p></article>',
  );
  expect(compactDocument.synchronizationUnits[1]?.narrationText).toBe(
    "During my life I played a role in developing software.\nAfter the break.",
  );
});

test("opens with the source title and source subtitle as two units inside an hgroup", async () => {
  const narrationDocument = await renderSourceMaterial({
    sourceTitle: "A Source Title",
    sourceSubtitle: "  A short summary beneath the title.  ",
    sourceMaterialHtml: "<p>The first paragraph.</p><p>The second paragraph.</p>",
  });

  expect(narrationDocument).toEqual({
    html: '<article><hgroup><h1 data-synchronization-unit="narration-unit-0001">A Source Title</h1><p data-synchronization-unit="narration-unit-0002">A short summary beneath the title.</p></hgroup><p data-synchronization-unit="narration-unit-0003">The first paragraph.</p><p data-synchronization-unit="narration-unit-0004">The second paragraph.</p></article>',
    synchronizationUnits: [
      { id: "narration-unit-0001", narrationText: "A Source Title" },
      { id: "narration-unit-0002", narrationText: "A short summary beneath the title." },
      { id: "narration-unit-0003", narrationText: "The first paragraph." },
      { id: "narration-unit-0004", narrationText: "The second paragraph." },
    ],
  });
});

test("keeps a heading right after the cut out of the source subtitle unit", async () => {
  const narrationDocument = await renderSourceMaterial({
    sourceTitle: "A Source Title",
    sourceSubtitle: "A short summary.",
    sourceMaterialHtml: "<h2>Introduction</h2><p>The first paragraph.</p>",
  });

  expect(narrationDocument).toEqual({
    html: '<article><hgroup><h1 data-synchronization-unit="narration-unit-0001">A Source Title</h1><p data-synchronization-unit="narration-unit-0002">A short summary.</p></hgroup><h2 data-synchronization-unit="narration-unit-0003">Introduction</h2><p data-synchronization-unit="narration-unit-0003">The first paragraph.</p></article>',
    synchronizationUnits: [
      { id: "narration-unit-0001", narrationText: "A Source Title" },
      { id: "narration-unit-0002", narrationText: "A short summary." },
      { id: "narration-unit-0003", narrationText: "Introduction\n\nThe first paragraph." },
    ],
  });
});

test("opens with the source title alone and no hgroup without a source subtitle", async () => {
  const narrationDocument = await renderSourceMaterial({
    sourceTitle: "A Source Title",
    sourceMaterialHtml: "<h2>Introduction</h2><p>The first paragraph.</p>",
  });

  expect(narrationDocument).toEqual({
    html: '<article><h1 data-synchronization-unit="narration-unit-0001">A Source Title</h1><h2 data-synchronization-unit="narration-unit-0002">Introduction</h2><p data-synchronization-unit="narration-unit-0002">The first paragraph.</p></article>',
    synchronizationUnits: [
      { id: "narration-unit-0001", narrationText: "A Source Title" },
      { id: "narration-unit-0002", narrationText: "Introduction\n\nThe first paragraph." },
    ],
  });
});

test("loads a unit that the withdrawn speech policy 7 marked as continuing its narration block", async () => {
  const unit = { id: "narration-unit-0002", narrationText: "Rest.", continuesNarrationBlock: true };

  expect(SYNCHRONIZATION_UNIT_SCHEMA.parse(unit)).toStrictEqual(unit);
});

test("never marks a unit as continuing its narration block", async () => {
  const { synchronizationUnits } = await renderSourceMaterial({
    sourceTitle: "Titel",
    sourceMaterialHtml: `<p>${"Ein Satz, der lang genug ist. ".repeat(120)}</p>`,
  });

  expect(synchronizationUnits.length).toBeGreaterThan(2);
  expect(synchronizationUnits.every((unit) => !("continuesNarrationBlock" in unit))).toBe(true);
});

test("places a heading before the list it introduces, with the unit of the first item", async () => {
  expect(
    (
      await renderSourceMaterial({
        sourceTitle: "A Source Title",
        sourceSubtitle: "A source subtitle",
        sourceMaterialHtml:
          "<h2>A list</h2><ul><li>First <b>item</b></li><li>Second item</li></ul>",
      })
    ).html,
  ).toBe(
    '<article><hgroup><h1 data-synchronization-unit="narration-unit-0001">A Source Title</h1><p data-synchronization-unit="narration-unit-0002">A source subtitle</p></hgroup><h2 data-synchronization-unit="narration-unit-0003">A list</h2><ul><li><p data-synchronization-unit="narration-unit-0003">First <b>item</b></p></li><li><p data-synchronization-unit="narration-unit-0004">Second item</p></li></ul></article>',
  );
});

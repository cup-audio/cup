import { expect, test } from "vitest";

import { renderNarrationDocument } from "#src/narration-document-creation.ts";

const ORIGINAL_URL = "https://publisher.example/articles/story";

function renderParagraph(paragraphHtml: string, narrationText: string): string {
  const { html, mismatch } = renderNarrationDocument({
    narrationDocument: {
      html: `<article><p id="narration-unit-0001">${paragraphHtml}</p></article>`,
      synchronizationUnits: [{ id: "narration-unit-0001", narrationText }],
    },
    originalUrl: ORIGINAL_URL,
  });

  expect(mismatch).toBeUndefined();

  return html;
}

test("keeps http and https links with only an absolute href resolved against the original URL", () => {
  expect(
    renderParagraph(
      '<a href="../about" lang="en">Relative</a>, <a href="//cdn.example/x">protocol-relative</a>, <a href="http://plain.example/">plain</a> and <a href="https://secure.example/a?b=1&amp;c=2">secure</a>',
      "Relative, protocol-relative, plain and secure",
    ),
  ).toBe(
    '<article><p data-synchronization-unit="narration-unit-0001"><a href="https://publisher.example/about">Relative</a>, <a href="https://cdn.example/x">protocol-relative</a>, <a href="http://plain.example/">plain</a> and <a href="https://secure.example/a?b=1&amp;c=2">secure</a></p></article>',
  );
});

test("flattens links that aren't web links to other pages to their text", () => {
  expect(
    renderParagraph(
      [
        '<a href="mailto:editor@publisher.example">mail</a>',
        '<a href="tel:+43123">phone</a>',
        `<a href="javascript:alert('no')">script</a>`,
        '<a href="#footnote-1">fragment</a>',
        '<a href="/articles/story#footnote-2">same page</a>',
        '<a href="https://publisher.example/articles/story#footnote-3">same page absolute</a>',
        '<a href="https://[unresolvable">unresolvable</a>',
        "<a>no href</a>",
        '<a href=" ">blank href</a>',
        '<a href="https://elsewhere.example/"><!-- a comment --><em>kept</em> <strong>markup</strong></a>',
      ].join(" "),
      "mail phone script fragment same page same page absolute unresolvable no href blank href kept markup",
    ),
  ).toBe(
    '<article><p data-synchronization-unit="narration-unit-0001">mail phone script fragment same page same page absolute unresolvable no href blank href <a href="https://elsewhere.example/"><em>kept</em> <strong>markup</strong></a></p></article>',
  );
});

test("keeps a link to the page itself without a fragment", () => {
  expect(renderParagraph('<a href="/articles/story">this story</a>', "this story")).toBe(
    '<article><p data-synchronization-unit="narration-unit-0001"><a href="https://publisher.example/articles/story">this story</a></p></article>',
  );
});

test("drops links whose text is empty or whitespace-only", () => {
  expect(
    renderParagraph(
      'Before<a href="https://image.example/"></a> <a href="https://space.example/"> </a>after.',
      "Before after.",
    ),
  ).toBe('<article><p data-synchronization-unit="narration-unit-0001">Before after.</p></article>');
});

test("strips every attribute but the unit attribute and a kept link's href", () => {
  expect(
    renderParagraph(
      '<span class="x">Flattened</span><!-- a comment --> <em lang="fr">gardé</em> <code dir="ltr">code</code><br>next',
      "Flattened gardé code\nnext",
    ),
  ).toBe(
    '<article><p data-synchronization-unit="narration-unit-0001">Flattened <em>gardé</em> <code>code</code><br>next</p></article>',
  );
});

test("clones a link that spans a unit boundary into each unit", () => {
  const { html } = renderNarrationDocument({
    narrationDocument: {
      html: '<article><p id="narration-unit-0001">One <a href="/cited">cited</a></p><p id="narration-unit-0002"><a href="/cited">source</a> two</p></article>',
      synchronizationUnits: [
        { id: "narration-unit-0001", narrationText: "One cited" },
        { id: "narration-unit-0002", narrationText: "source two" },
      ],
    },
    originalUrl: ORIGINAL_URL,
  });

  expect(html).toBe(
    '<article><p data-synchronization-unit="narration-unit-0001">One <a href="https://publisher.example/cited">cited</a></p><p data-synchronization-unit="narration-unit-0002"><a href="https://publisher.example/cited">source</a> two</p></article>',
  );
});

const STORED_HTML =
  '<article>\n<h1 id="narration-unit-0001">Title</h1><section id="narration-unit-0002"><h2>Heading</h2><p>First <a href="/a">paragraph</a>.</p></section><p id="narration-unit-0003">Second &amp; last<br>line.</p></article>';

const STORED_UNITS = [
  { id: "narration-unit-0001", narrationText: "Title" },
  { id: "narration-unit-0002", narrationText: "Heading\n\nFirst paragraph." },
  { id: "narration-unit-0003", narrationText: "Second & last\nline." },
];

const FALLBACK_HTML =
  '<article><p data-synchronization-unit="narration-unit-0001">Title</p><p data-synchronization-unit="narration-unit-0002">Heading<br><br>First paragraph.</p><p data-synchronization-unit="narration-unit-0003">Second &amp; last<br>line.</p></article>';

test("passes when the stored units differ from the stored HTML only in whitespace", () => {
  const rendered = renderNarrationDocument({
    narrationDocument: {
      html: STORED_HTML,
      synchronizationUnits: [
        { id: "narration-unit-0001", narrationText: " Title " },
        { id: "narration-unit-0002", narrationText: "Heading First\tparagraph." },
        { id: "narration-unit-0003", narrationText: "Second &  last line." },
      ],
    },
    originalUrl: ORIGINAL_URL,
  });

  expect(rendered.mismatch).toBeUndefined();
  expect(rendered.html).toBe(
    '<article>\n<h1 data-synchronization-unit="narration-unit-0001">Title</h1><h2 data-synchronization-unit="narration-unit-0002">Heading</h2><p data-synchronization-unit="narration-unit-0002">First <a href="https://publisher.example/a">paragraph</a>.</p><p data-synchronization-unit="narration-unit-0003">Second &amp; last<br>line.</p></article>',
  );
});

test("serves the fallback document and names the first differing unit when a unit ID changed", () => {
  const synchronizationUnits = [
    STORED_UNITS[0]!,
    { ...STORED_UNITS[1]!, id: "narration-unit-0009" },
    STORED_UNITS[2]!,
  ];

  expect(
    renderNarrationDocument({
      narrationDocument: { html: STORED_HTML, synchronizationUnits },
      originalUrl: ORIGINAL_URL,
    }),
  ).toEqual({
    html: '<article><p data-synchronization-unit="narration-unit-0001">Title</p><p data-synchronization-unit="narration-unit-0009">Heading<br><br>First paragraph.</p><p data-synchronization-unit="narration-unit-0003">Second &amp; last<br>line.</p></article>',
    synchronizationUnits,
    mismatch: {
      reason: "unit-id",
      unitIndex: 1,
      storedUnitId: "narration-unit-0009",
      renderedUnitId: "narration-unit-0002",
    },
  });
});

test("serves the fallback document and names the first differing unit when the unit order changed", () => {
  const synchronizationUnits = [STORED_UNITS[0]!, STORED_UNITS[2]!, STORED_UNITS[1]!];

  expect(
    renderNarrationDocument({
      narrationDocument: { html: STORED_HTML, synchronizationUnits },
      originalUrl: ORIGINAL_URL,
    }),
  ).toEqual({
    html: '<article><p data-synchronization-unit="narration-unit-0001">Title</p><p data-synchronization-unit="narration-unit-0003">Second &amp; last<br>line.</p><p data-synchronization-unit="narration-unit-0002">Heading<br><br>First paragraph.</p></article>',
    synchronizationUnits,
    mismatch: {
      reason: "unit-id",
      unitIndex: 1,
      storedUnitId: "narration-unit-0003",
      renderedUnitId: "narration-unit-0002",
    },
  });
});

test("serves the fallback document and names the first differing unit when a unit's text changed", () => {
  const synchronizationUnits = [
    STORED_UNITS[0]!,
    STORED_UNITS[1]!,
    { ...STORED_UNITS[2]!, narrationText: "Second and last line." },
  ];

  expect(
    renderNarrationDocument({
      narrationDocument: { html: STORED_HTML, synchronizationUnits },
      originalUrl: ORIGINAL_URL,
    }),
  ).toEqual({
    html: '<article><p data-synchronization-unit="narration-unit-0001">Title</p><p data-synchronization-unit="narration-unit-0002">Heading<br><br>First paragraph.</p><p data-synchronization-unit="narration-unit-0003">Second and last line.</p></article>',
    synchronizationUnits,
    mismatch: {
      reason: "narration-text",
      unitIndex: 2,
      storedUnitId: "narration-unit-0003",
      renderedUnitId: "narration-unit-0003",
    },
  });
});

test("names the first missing or unexpected unit when the unit counts differ", () => {
  expect(
    renderNarrationDocument({
      narrationDocument: { html: STORED_HTML, synchronizationUnits: STORED_UNITS.slice(0, 2) },
      originalUrl: ORIGINAL_URL,
    }).mismatch,
  ).toEqual({ reason: "unexpected-unit", unitIndex: 2, renderedUnitId: "narration-unit-0003" });

  expect(
    renderNarrationDocument({
      narrationDocument: {
        html: STORED_HTML,
        synchronizationUnits: [
          ...STORED_UNITS,
          { id: "narration-unit-0004", narrationText: "More" },
        ],
      },
      originalUrl: ORIGINAL_URL,
    }),
  ).toEqual({
    html: FALLBACK_HTML.replace(
      "</article>",
      '<p data-synchronization-unit="narration-unit-0004">More</p></article>',
    ),
    synchronizationUnits: [...STORED_UNITS, { id: "narration-unit-0004", narrationText: "More" }],
    mismatch: { reason: "missing-unit", unitIndex: 3, storedUnitId: "narration-unit-0004" },
  });
});

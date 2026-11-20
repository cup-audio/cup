import { expect, test } from "vitest";

import {
  renderNarrationDocument,
  segmentNarrationDocument,
} from "#src/narration-document-creation.ts";

const FETCHED_URL = "https://publisher.example/articles/story";

/**
 * Renders narration source material as a new conversion whose stored units are the ones
 * segmentation version 1 derives from it, and returns the narration document's body after the
 * source title.
 */
function renderBody(sourceMaterialHtml: string): string {
  const sourceTitle = "Story title";
  const { synchronizationUnits } = segmentNarrationDocument({
    segmentationVersion: 1,
    sourceTitle,
    sourceMaterialHtml,
  });
  const { html, mismatch } = renderNarrationDocument({
    narrationDocument: { segmentationVersion: 1, fetchedUrl: FETCHED_URL, synchronizationUnits },
    narrationSourceMaterialHtml: sourceMaterialHtml,
    originalUrl: FETCHED_URL,
    sourceTitle,
  });
  const opening = `<article><h1 data-synchronization-unit="narration-unit-0001">${sourceTitle}</h1>`;

  expect(mismatch).toBeUndefined();
  expect(html.startsWith(opening) && html.endsWith("</article>")).toBe(true);

  return html.slice(opening.length, -"</article>".length);
}

test("restores a table with its caption, row groups and header cells in a scroll card, each cell its own unit", () => {
  expect(
    renderBody(
      '<table class="data">\n  <caption>Latency by region</caption>\n  <colgroup><col span="2"></colgroup>\n  <thead><tr><th scope="col">Region</th><th>Latency</th></tr></thead>\n  <tbody>\n    <tr><td>Europe</td><td>380 ms</td></tr>\n    <tr><td><p>Asia</p><p>and Oceania</p></td><td>420 <sub>ms</sub></td></tr>\n  </tbody>\n  <tfoot><tr><td></td><td>Median</td></tr></tfoot>\n</table>',
    ),
  ).toBe(
    '<div data-scroll-card=""><table><caption data-synchronization-unit="narration-unit-0002">Latency by region</caption><thead><tr><th data-synchronization-unit="narration-unit-0003">Region</th><th data-synchronization-unit="narration-unit-0004">Latency</th></tr></thead><tbody><tr><td data-synchronization-unit="narration-unit-0005">Europe</td><td data-synchronization-unit="narration-unit-0006">380 ms</td></tr><tr><td><p data-synchronization-unit="narration-unit-0007">Asia</p><p data-synchronization-unit="narration-unit-0008">and Oceania</p></td><td data-synchronization-unit="narration-unit-0009">420 <sub>ms</sub></td></tr></tbody><tfoot><tr><td></td><td data-synchronization-unit="narration-unit-0010">Median</td></tr></tfoot></table></div>',
  );
});

test("restores a description list with each term and description its own unit", () => {
  expect(
    renderBody(
      '<dl class="glossary">\n  <dt id="one">Term one</dt>\n  <dd>Description one.</dd>\n  <div><dt>Term two</dt><dd><p>Description two.</p><p>More.</p></dd></div>\n  <dd></dd>\n</dl>',
    ),
  ).toBe(
    '<dl><dt data-synchronization-unit="narration-unit-0002">Term one</dt><dd data-synchronization-unit="narration-unit-0003">Description one.</dd><dt data-synchronization-unit="narration-unit-0004">Term two</dt><dd><p data-synchronization-unit="narration-unit-0005">Description two.</p><p data-synchronization-unit="narration-unit-0006">More.</p></dd></dl>',
  );
});

test("restores preformatted text with its line breaks in a scroll card", () => {
  expect(renderBody("<pre>A short poem\n  with indented lines\n\nand a blank line.</pre>")).toBe(
    '<div data-scroll-card=""><pre data-synchronization-unit="narration-unit-0002">A short poem<br>with indented lines<br>and a blank line.</pre></div>',
  );
});

test("keeps the line breaks around kept markup in preformatted text", () => {
  expect(renderBody("<pre>A line<code>\ncode</code>\n<b> and bold</b></pre>")).toBe(
    '<div data-scroll-card=""><pre data-synchronization-unit="narration-unit-0002">A line<br><code>code</code><br><b>and bold</b></pre></div>',
  );
});

test("keeps the paragraphs that preformatted text holds, each its own unit", () => {
  expect(renderBody("<pre>Introduction<p>A paragraph.</p></pre>")).toBe(
    '<div data-scroll-card=""><pre><p data-synchronization-unit="narration-unit-0002">Introduction</p><p data-synchronization-unit="narration-unit-0003">A paragraph.</p></pre></div>',
  );
});

test("marks a cell that holds text beside a paragraph through paragraphs inside it", () => {
  expect(
    renderBody(
      "<table><tr><td><!-- note -->Text<p>A paragraph.</p></td><td> <img src=x.png>Europe <!-- note --></td></tr></table>",
    ),
  ).toBe(
    '<div data-scroll-card=""><table><tbody><tr><td><p data-synchronization-unit="narration-unit-0002">Text</p><p data-synchronization-unit="narration-unit-0003">A paragraph.</p></td><td data-synchronization-unit="narration-unit-0004">Europe</td></tr></tbody></table></div>',
  );
});

test("shows trailing headings split into several units as one heading per unit", () => {
  const words = Array.from({ length: 500 }, (_, index) => `word${index + 1}`).join(" ");
  const body = renderBody(`<p>Body.</p><h2>${words}</h2><h3>Last</h3>`);
  const unitBoundary = '</h2><h2 data-synchronization-unit="narration-unit-0004">';

  expect(body.split(unitBoundary)).toHaveLength(2);
  expect(body.replace(unitBoundary, " ")).toBe(
    `<p data-synchronization-unit="narration-unit-0002">Body.</p><h2 data-synchronization-unit="narration-unit-0003">${words}</h2><h3 data-synchronization-unit="narration-unit-0004">Last</h3>`,
  );
});

test("shows preformatted text split into several units as one pre per unit in one scroll card", () => {
  const lines = Array.from(
    { length: 90 },
    (_, index) => `line ${index + 1} of a poem that goes on`,
  );
  const body = renderBody(`<pre><b>${lines.join("\n")}</b></pre>`);
  const unitBoundary = '</b></pre><pre data-synchronization-unit="narration-unit-0003"><b>';

  expect(body.split(unitBoundary)).toHaveLength(2);
  // The units split the text between two words of one line.
  expect(body.replace(unitBoundary, " ")).toBe(
    `<div data-scroll-card=""><pre data-synchronization-unit="narration-unit-0002"><b>${lines.join("<br>")}</b></pre></div>`,
  );
});

test("shows table rows and cells outside a table as paragraphs, which a browser would drop", () => {
  expect(renderBody("<tr><th>Header</th><td>Cell</td></tr><caption>Caption</caption>")).toBe(
    '<p data-synchronization-unit="narration-unit-0002">Header</p><p data-synchronization-unit="narration-unit-0003">Cell</p><p data-synchronization-unit="narration-unit-0004">Caption</p>',
  );
});

test("places a heading before its table with the unit of the table's first cell", () => {
  expect(renderBody("<h2>Results</h2><table><tr><td>Europe</td></tr></table>")).toBe(
    '<h2 data-synchronization-unit="narration-unit-0002">Results</h2><div data-scroll-card=""><table><tbody><tr><td data-synchronization-unit="narration-unit-0002">Europe</td></tr></tbody></table></div>',
  );
});

test("places a heading before its description list with the unit of the first term", () => {
  expect(renderBody("<h2>Terms</h2><dl><dt>Term</dt><dd>Description.</dd></dl>")).toBe(
    '<h2 data-synchronization-unit="narration-unit-0002">Terms</h2><dl><dt data-synchronization-unit="narration-unit-0002">Term</dt><dd data-synchronization-unit="narration-unit-0003">Description.</dd></dl>',
  );
});

test("drops horizontal rules, and tables, lists and preformatted text without narration text", () => {
  expect(
    renderBody(
      "<p>Before.</p><hr><table><tr><td> </td></tr></table><ul><li><img src=x.png></li></ul><pre>\n</pre><p>After.</p>",
    ),
  ).toBe(
    '<p data-synchronization-unit="narration-unit-0002">Before.</p><p data-synchronization-unit="narration-unit-0003">After.</p>',
  );
});

test.for(["em", "strong", "b", "i", "code", "kbd", "samp", "var", "sub", "sup", "s", "del", "q"])(
  "keeps %s as itself",
  (tagName) => {
    expect(renderBody(`<p>A <${tagName}>kept</${tagName}> word.</p>`)).toBe(
      `<p data-synchronization-unit="narration-unit-0002">A <${tagName}>kept</${tagName}> word.</p>`,
    );
  },
);

test("keeps br as a line break", () => {
  expect(renderBody("<p>A line<br>and the next.</p>")).toBe(
    '<p data-synchronization-unit="narration-unit-0002">A line<br>and the next.</p>',
  );
});

test.for([
  ["abbr", ' title="Hypertext Markup Language"'],
  ["bdi", ""],
  ["bdo", ' dir="rtl"'],
  ["cite", ""],
  ["data", ' value="42"'],
  ["dfn", ""],
  ["ins", ""],
  ["label", ""],
  ["mark", ""],
  ["small", ""],
  ["span", ""],
  ["time", ' datetime="2026-11-20"'],
  ["u", ""],
  ["custom-inline", ""],
])("flattens %s to its text", ([tagName, attributes]) => {
  expect(renderBody(`<p>A <${tagName}${attributes}>flattened</${tagName}> word.</p>`)).toBe(
    '<p data-synchronization-unit="narration-unit-0002">A flattened word.</p>',
  );
});

test("flattens ruby and wbr to their text", () => {
  expect(renderBody("<p>A <ruby>漢<rt>kan</rt></ruby> long<wbr>word.</p>")).toBe(
    '<p data-synchronization-unit="narration-unit-0002">A 漢kan longword.</p>',
  );
});

test("strips every attribute from kept elements, and keeps only the absolute href of links", () => {
  const attributes = 'class="c" style="color: red" title="t" lang="en" id="i" dir="ltr"';

  expect(
    renderBody(
      `<blockquote ${attributes}><p ${attributes}><em ${attributes}>Kept</em> and <a ${attributes} href="/elsewhere" target="_blank">linked</a>.</p></blockquote><table ${attributes}><tr ${attributes}><td ${attributes}>Cell</td></tr></table>`,
    ),
  ).toBe(
    '<blockquote><p data-synchronization-unit="narration-unit-0002"><em>Kept</em> and <a href="https://publisher.example/elsewhere">linked</a>.</p></blockquote><div data-scroll-card=""><table><tbody><tr><td data-synchronization-unit="narration-unit-0003">Cell</td></tr></tbody></table></div>',
  );
});

test("flattens links that are not kept to their text and drops links without text", () => {
  expect(
    renderBody(
      '<p><a href="#note">Fragment</a>, <a href="mailto:a@b.example">mail</a> and <a href="https://elsewhere.example/"> </a>gap.</p>',
    ),
  ).toBe('<p data-synchronization-unit="narration-unit-0002">Fragment, mail and gap.</p>');
});

test("clones kept inline markup and links that span a unit boundary into each unit", () => {
  const words = Array.from({ length: 500 }, (_, index) => `word${index + 1}`).join(" ");
  const body = renderBody(
    `<p><a href="/cited"><strong>${words}</strong></a></p><table><tr><td><q>${words}</q></td></tr></table>`,
  );

  expect(body.match(/<a href="https:\/\/publisher\.example\/cited"><strong>/gu)).toHaveLength(2);
  expect(body.match(/<p data-synchronization-unit=/gu)).toHaveLength(4);
  expect(body.match(/<q>/gu)).toHaveLength(2);
  expect(body).toMatch(
    /<td><p data-synchronization-unit="narration-unit-0004"><q>word1 .*<\/q><\/p><p data-synchronization-unit="narration-unit-0005"><q>.* word500<\/q><\/p><\/td>/u,
  );
});

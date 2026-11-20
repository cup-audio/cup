import fs from "node:fs";
import path from "node:path";
import { parseFragment } from "parse5";
import type { DefaultTreeAdapterMap } from "parse5";
import { expect, test } from "vitest";
import { z } from "zod";

import {
  renderNarrationDocument,
  segmentNarrationDocument,
} from "#src/narration-document-creation.ts";
import type { SynchronizationUnit } from "#src/narration-document-creation.ts";

const FETCHED_URL = "https://publisher.example/articles/story";

const VERSION_2_FIXTURES_DIRECTORY = path.join(
  import.meta.dirname,
  "..",
  "segmentation-version-2",
  "golden-fixtures",
);

const SEGMENTATION_FIXTURE_INPUT_SCHEMA = z.object({
  sourceTitle: z.string(),
  sourceSubtitle: z.string().exactOptional(),
  sourceMaterialHtml: z.string(),
});

/**
 * Segments narration source material with segmentation version 2 and renders it as a new conversion
 * whose stored units are the derived ones, as preparation and the listener API do.
 */
function renderWithVersion2(options: {
  sourceTitle: string;
  sourceSubtitle?: string;
  sourceMaterialHtml: string;
}): { html: string; synchronizationUnits: readonly SynchronizationUnit[] } {
  const { synchronizationUnits } = segmentNarrationDocument({ ...options, segmentationVersion: 2 });
  const { html, mismatch } = renderNarrationDocument({
    narrationDocument: {
      segmentationVersion: 2,
      sourceSubtitle: options.sourceSubtitle,
      fetchedUrl: FETCHED_URL,
      synchronizationUnits,
    },
    narrationSourceMaterialHtml: options.sourceMaterialHtml,
    originalUrl: FETCHED_URL,
    sourceTitle: options.sourceTitle,
  });

  expect(mismatch).toBeUndefined();

  return { html, synchronizationUnits };
}

/** Returns the narration document's body after the source title. */
function renderBody(sourceMaterialHtml: string): string {
  const sourceTitle = "Story title";
  const { html } = renderWithVersion2({ sourceTitle, sourceMaterialHtml });
  const opening = `<article><h1 data-synchronization-unit="narration-unit-0001">${sourceTitle}</h1>`;

  expect(html.startsWith(opening) && html.endsWith("</article>")).toBe(true);

  return html.slice(opening.length, -"</article>".length);
}

/**
 * The text a listener sees for each unit, in unit order: the text of every element that carries the
 * unit's attribute, joined like narration text joins blocks, with a table row's non-empty cells
 * joined by ", " and a `br` read as a line break.
 */
function readShownUnitTexts(html: string): Map<string, string> {
  const elementTexts = new Map<string, string[]>();

  function visit(node: DefaultTreeAdapterMap["parentNode"]): void {
    for (const childNode of node.childNodes) {
      if (!("tagName" in childNode)) {
        continue;
      }

      const unitId = childNode.attrs.find(
        (attribute) => attribute.name === "data-synchronization-unit",
      )?.value;

      if (unitId === undefined) {
        visit(childNode);
        continue;
      }

      elementTexts.set(unitId, [...(elementTexts.get(unitId) ?? []), extractShownText(childNode)]);
    }
  }

  visit(parseFragment(html));

  return new Map([...elementTexts].map(([unitId, texts]) => [unitId, texts.join("\n\n")] as const));
}

function extractShownText(node: DefaultTreeAdapterMap["childNode"]): string {
  if ("value" in node) {
    return node.value;
  }

  if (!("tagName" in node)) {
    return "";
  }

  if (node.tagName === "br") {
    return "\n";
  }

  if (node.tagName === "tr") {
    return node.childNodes
      .map((cell) => extractShownText(cell).trim())
      .filter((cellText) => cellText.length > 0)
      .join(", ");
  }

  return node.childNodes.map(extractShownText).join("");
}

test("marks each table row as one unit and the caption as its own, keeping cells and empty cells", () => {
  expect(
    renderBody(
      '<table class="data">\n  <caption>Latency by region</caption>\n  <thead><tr><th scope="col">Region</th><th>Latency</th></tr></thead>\n  <tbody>\n    <tr><td>Europe</td><td>380 ms</td></tr>\n    <tr><td><p>Asia</p><p>and Oceania</p></td><td>420 <sub>ms</sub></td></tr>\n  </tbody>\n  <tfoot><tr><td></td><td colspan="2">Median</td></tr></tfoot>\n</table>',
    ),
  ).toBe(
    '<div data-scroll-card=""><table><caption data-synchronization-unit="narration-unit-0002">Latency by region</caption><thead><tr data-synchronization-unit="narration-unit-0003"><th>Region</th><th>Latency</th></tr></thead><tbody><tr data-synchronization-unit="narration-unit-0004"><td>Europe</td><td>380 ms</td></tr><tr data-synchronization-unit="narration-unit-0005"><td>Asia and Oceania</td><td>420 <sub>ms</sub></td></tr></tbody><tfoot><tr data-synchronization-unit="narration-unit-0006"><td></td><td>Median</td></tr></tfoot></table></div>',
  );
});

test("places a heading before its table with the unit of the table's first row", () => {
  expect(renderBody("<h2>Prices</h2><table><tr><td>Basic</td><td>5 €</td></tr></table>")).toBe(
    '<h2 data-synchronization-unit="narration-unit-0002">Prices</h2><div data-scroll-card=""><table><tbody><tr data-synchronization-unit="narration-unit-0002"><td>Basic</td><td>5 €</td></tr></tbody></table></div>',
  );
});

test("marks each description list group as one unit across its terms and descriptions", () => {
  expect(
    renderBody(
      "<h2>Terms</h2><dl>\n  <dt>Term one</dt>\n  <dt>Term one, again</dt>\n  <dd>Description one.</dd>\n  <div><dt>Term two</dt><dd><p>First.</p><p>Second.</p></dd></div>\n  <dd></dd>\n</dl>",
    ),
  ).toBe(
    '<h2 data-synchronization-unit="narration-unit-0002">Terms</h2><dl><dt data-synchronization-unit="narration-unit-0002">Term one</dt><dt data-synchronization-unit="narration-unit-0002">Term one, again</dt><dd data-synchronization-unit="narration-unit-0002">Description one.</dd><dt data-synchronization-unit="narration-unit-0003">Term two</dt><dd data-synchronization-unit="narration-unit-0003">First. Second.</dd></dl>',
  );
});

test("shows preformatted text split at line breaks as one pre per unit in one scroll card", () => {
  const lines = Array.from({ length: 100 }, (_, index) => `line ${index + 1} of a long poem`);
  const body = renderBody(`<pre>${lines.join("\n")}</pre>`);

  expect(body).toBe(
    `<div data-scroll-card=""><pre data-synchronization-unit="narration-unit-0002">${lines.slice(0, 87).join("<br>")}</pre><pre data-synchronization-unit="narration-unit-0003">${lines.slice(87).join("<br>")}</pre></div>`,
  );
});

test.for(
  fs
    .readdirSync(VERSION_2_FIXTURES_DIRECTORY)
    .filter((fileName) => fileName.endsWith(".json"))
    .toSorted(),
)("shows exactly the narration text of every unit of the golden fixture %s", (fileName) => {
  const fixture = SEGMENTATION_FIXTURE_INPUT_SCHEMA.parse(
    JSON.parse(fs.readFileSync(path.join(VERSION_2_FIXTURES_DIRECTORY, fileName), "utf8")),
  );
  const { html, synchronizationUnits } = renderWithVersion2(fixture);

  expect(readShownUnitTexts(html)).toEqual(
    new Map(synchronizationUnits.map(({ id, narrationText }) => [id, narrationText] as const)),
  );
});

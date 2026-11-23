import process from "node:process";
import { expect, test } from "vitest";

import {
  renderNarrationDocument,
  segmentNarrationDocument,
  type SegmentationVersion,
} from "#src/index.ts";

const MAX_NARRATION_CHARACTERS = 40_000;
const MAX_SYNCHRONIZATION_UNITS = 200;

const CPU_BUDGET_MILLISECONDS = 50;

const SOURCE_TITLE = "The largest narration document";
const SENTENCE = 'A sentence with <em>emphasis</em> and a <a href="/cited">cited source</a>, too. ';
const SENTENCE_TEXT_LENGTH = 50;

test.for([1, 2] as const)(
  "segments with segmentation version %i and renders the largest allowed narration source material, with tables, description lists and preformatted text, within the CPU budget",
  async (segmentationVersion) => {
    const narrationSourceMaterialHtml = createLargestSourceMaterialHtml(segmentationVersion);
    const { synchronizationUnits } = segmentNarrationDocument({
      segmentationVersion,
      sourceTitle: SOURCE_TITLE,
      sourceMaterialHtml: narrationSourceMaterialHtml,
    });

    expect(synchronizationUnits).toHaveLength(MAX_SYNCHRONIZATION_UNITS);
    expect(countNarrationCharacters(synchronizationUnits)).toBeGreaterThan(
      MAX_NARRATION_CHARACTERS * 0.95,
    );
    expect(countNarrationCharacters(synchronizationUnits)).toBeLessThanOrEqual(
      MAX_NARRATION_CHARACTERS,
    );

    const cpuMilliseconds: number[] = [];

    for (let render = 0; render < 5; render += 1) {
      const cpuUsageBefore = process.cpuUsage();
      const rendered = await renderNarrationDocument({
        narrationDocument: { segmentationVersion, synchronizationUnits },
        loadNarrationSourceMaterial: async () => narrationSourceMaterialHtml,
        originalUrl: "https://publisher.example/articles/story",
        sourceTitle: SOURCE_TITLE,
      });
      const cpuUsage = process.cpuUsage(cpuUsageBefore);

      expect(rendered.mismatch).toBeUndefined();
      expect(rendered.failure).toBeUndefined();

      cpuMilliseconds.push((cpuUsage.user + cpuUsage.system) / 1000);
    }

    expect(Math.min(...cpuMilliseconds)).toBeLessThan(CPU_BUDGET_MILLISECONDS);
  },
);

function createLargestSourceMaterialHtml(segmentationVersion: SegmentationVersion): string {
  const tableRows = Array.from(
    { length: 12 },
    (_, row) =>
      `<tr>${Array.from({ length: 4 }, (_cell, column) => `<td>Cell <b>${row}</b> of column ${column}</td>`).join("")}</tr>`,
  );
  const descriptionListGroups = Array.from(
    { length: 8 },
    (_, group) => `<dt>Term ${group}</dt><dd>${SENTENCE.repeat(2)}</dd>`,
  );
  const preformattedLines = Array.from(
    { length: 60 },
    (_, line) => `${" ".repeat((line % 4) * 2)}const value${line} = compute(${line});`,
  );
  const structuredHtml = [
    `<h2>A table</h2><table><thead><tr><th>Region</th><th>Latency</th><th>Error rate</th><th>Notes</th></tr></thead><tbody>${tableRows.join("")}</tbody></table>`,
    `<h2>A description list</h2><dl>${descriptionListGroups.join("")}</dl>`,
    `<h2>Preformatted text</h2><pre>${preformattedLines.join("\n")}</pre>`,
  ].join("");
  const structuredUnits = segmentNarrationDocument({
    segmentationVersion,
    sourceTitle: SOURCE_TITLE,
    sourceMaterialHtml: structuredHtml,
  }).synchronizationUnits;
  const paragraphCount = MAX_SYNCHRONIZATION_UNITS - structuredUnits.length;
  const paragraphCharacters =
    (MAX_NARRATION_CHARACTERS - countNarrationCharacters(structuredUnits)) / paragraphCount;
  const sentenceCount = Math.floor(paragraphCharacters / SENTENCE_TEXT_LENGTH);
  const fillingWord = "w".repeat(
    Math.floor(paragraphCharacters) - sentenceCount * SENTENCE_TEXT_LENGTH,
  );
  const paragraphHtml = `<p>${SENTENCE.repeat(sentenceCount)}${fillingWord}</p>`;

  return structuredHtml + paragraphHtml.repeat(paragraphCount);
}

function countNarrationCharacters(
  synchronizationUnits: readonly { narrationText: string }[],
): number {
  return synchronizationUnits
    .map(({ narrationText }) => narrationText.length)
    .reduce((sum, length) => sum + length, 0);
}

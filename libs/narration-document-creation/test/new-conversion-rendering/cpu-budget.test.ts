import process from "node:process";
import { expect, test } from "vitest";

import {
  renderNarrationDocument,
  segmentNarrationDocument,
  type SegmentationVersion,
} from "#src/narration-document-creation.ts";

// The largest narration document preparation accepts: its content limit is 40,000 characters of
// narration text in at most 200 synchronization units.
const MAX_NARRATION_CHARACTERS = 40_000;
const MAX_SYNCHRONIZATION_UNITS = 200;

// The CPU time one render may take, stricter than the Worker's configured limit (`limits.cpu_ms` in
// the Worker's Wrangler config) on purpose: the listener API renders on every request that carries
// the narration document, so rendering must stay small next to the request's other work, not just
// finish before the Worker is stopped.
const CPU_BUDGET_MILLISECONDS = 50;

const SOURCE_TITLE = "The largest narration document";
// 50 characters of narration text, with kept inline markup and a link.
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

    // The fastest of several renders, so a busy test machine doesn't fail the budget.
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

/**
 * A table, a description list and a long `pre`, each after a heading, followed by as many
 * paragraphs as fill the content limit's units and close to its characters under the given
 * segmentation version, which divides tables and description lists into units differently.
 */
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
  // One long word fills the rest, so the paragraphs come within a character each of the limit.
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

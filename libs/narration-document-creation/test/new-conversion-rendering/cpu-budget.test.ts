import process from "node:process";
import { expect, test } from "vitest";

import {
  renderNarrationDocument,
  segmentNarrationDocument,
} from "#src/narration-document-creation.ts";

// The largest narration document preparation accepts: its content limit is 40,000 characters of
// narration text in at most 200 synchronization units.
const MAX_NARRATION_CHARACTERS = 40_000;
const MAX_SYNCHRONIZATION_UNITS = 200;

// The same budget as for an existing conversion's render, which explains it.
const CPU_BUDGET_MILLISECONDS = 50;

test.for([1, 2] as const)(
  "segments with segmentation version %i and renders the largest allowed narration source material within the CPU budget",
  (segmentationVersion) => {
    // 50 characters of narration text, so 199 paragraphs of four sentences and their headings come
    // close to the limit.
    const sentence =
      'A sentence with <em>emphasis</em> and a <a href="/cited">cited source</a>, too. ';
    const paragraphHtml = `<p>${sentence.repeat(4)}</p>`;
    const sourceTitle = "The largest narration document";
    const narrationSourceMaterialHtml = Array.from(
      { length: MAX_SYNCHRONIZATION_UNITS - 1 },
      (_, index) => (index % 10 === 0 ? `<h2>Section ${index}</h2>` : "") + paragraphHtml,
    ).join("");
    const { synchronizationUnits } = segmentNarrationDocument({
      segmentationVersion,
      sourceTitle,
      sourceMaterialHtml: narrationSourceMaterialHtml,
    });
    const narrationCharacters = synchronizationUnits
      .map(({ narrationText }) => narrationText.length)
      .reduce((sum, length) => sum + length, 0);

    expect(synchronizationUnits).toHaveLength(MAX_SYNCHRONIZATION_UNITS);
    expect(narrationCharacters).toBeGreaterThan(MAX_NARRATION_CHARACTERS * 0.95);
    expect(narrationCharacters).toBeLessThanOrEqual(MAX_NARRATION_CHARACTERS);

    // The fastest of several renders, so a busy test machine doesn't fail the budget.
    const cpuMilliseconds = Array.from({ length: 5 }, () => {
      const cpuUsageBefore = process.cpuUsage();
      const rendered = renderNarrationDocument({
        narrationDocument: { segmentationVersion, synchronizationUnits },
        narrationSourceMaterialHtml,
        originalUrl: "https://publisher.example/articles/story",
        sourceTitle,
      });
      const cpuUsage = process.cpuUsage(cpuUsageBefore);

      expect(rendered.mismatch).toBeUndefined();

      return (cpuUsage.user + cpuUsage.system) / 1000;
    });

    expect(Math.min(...cpuMilliseconds)).toBeLessThan(CPU_BUDGET_MILLISECONDS);
  },
);

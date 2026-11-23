import process from "node:process";
import { expect, test } from "vitest";

import { renderNarrationDocument } from "#src/index.ts";

const MAX_NARRATION_CHARACTERS = 40_000;
const MAX_SYNCHRONIZATION_UNITS = 200;

const CPU_BUDGET_MILLISECONDS = 50;
const WITHOUT_NARRATION_SOURCE_MATERIAL = {
  sourceTitle: "Title",
  loadNarrationSourceMaterial: async () => {
    throw new Error("An existing conversion has no narration source material to load.");
  },
};

test("renders the largest allowed narration document within the CPU budget", async () => {
  const sentence =
    'A sentence with <em>emphasis</em> and a <a href="/cited">cited source</a>, too. ';
  const sentenceText = "A sentence with emphasis and a cited source, too. ";
  const paragraphHtml = sentence.repeat(4).trim();
  const paragraphText = sentenceText.repeat(4).trim();
  const unitIds = Array.from(
    { length: MAX_SYNCHRONIZATION_UNITS },
    (_, index) => `narration-unit-${String(index + 1).padStart(4, "0")}`,
  );
  const bodyHtml = unitIds
    .slice(1)
    .map((unitId, index) =>
      index % 10 === 0
        ? `<section id="${unitId}"><h2>Section ${index}</h2><p>${paragraphHtml}</p></section>`
        : `<p id="${unitId}">${paragraphHtml}</p>`,
    );
  const narrationDocument = {
    html: `<article><h1 id="${unitIds[0]}">The largest narration document</h1>${bodyHtml.join("")}</article>`,
    synchronizationUnits: unitIds.map((id, index) => ({
      id,
      narrationText:
        index === 0
          ? "The largest narration document"
          : (index - 1) % 10 === 0
            ? `Section ${index - 1}\n\n${paragraphText}`
            : paragraphText,
    })),
  };
  const narrationCharacters = narrationDocument.synchronizationUnits
    .map(({ narrationText }) => narrationText.length)
    .reduce((sum, length) => sum + length, 0);

  expect(narrationDocument.synchronizationUnits).toHaveLength(MAX_SYNCHRONIZATION_UNITS);
  expect(narrationCharacters).toBeGreaterThan(MAX_NARRATION_CHARACTERS * 0.95);
  expect(narrationCharacters).toBeLessThanOrEqual(MAX_NARRATION_CHARACTERS);

  const cpuMilliseconds: number[] = [];

  for (let render = 0; render < 5; render += 1) {
    const cpuUsageBefore = process.cpuUsage();
    const rendered = await renderNarrationDocument({
      narrationDocument,
      originalUrl: "https://publisher.example/articles/story",
      ...WITHOUT_NARRATION_SOURCE_MATERIAL,
    });
    const cpuUsage = process.cpuUsage(cpuUsageBefore);

    expect(rendered.mismatch).toBeUndefined();

    cpuMilliseconds.push((cpuUsage.user + cpuUsage.system) / 1000);
  }

  expect(Math.min(...cpuMilliseconds)).toBeLessThan(CPU_BUDGET_MILLISECONDS);
});

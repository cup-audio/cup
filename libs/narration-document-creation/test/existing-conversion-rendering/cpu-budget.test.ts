import process from "node:process";
import { expect, test } from "vitest";

import {
  createNarrationDocument,
  renderNarrationDocument,
} from "#src/narration-document-creation.ts";

// The largest narration document preparation accepts: its content limit is 40,000 characters of
// narration text in at most 200 synchronization units.
const MAX_NARRATION_CHARACTERS = 40_000;
const MAX_SYNCHRONIZATION_UNITS = 200;

// The CPU time one render may take. The Worker's configured limit is far higher (`limits.cpu_ms`
// in the Worker's Wrangler config), but the listener API renders on every request that carries the
// narration document, so rendering must stay small next to the request's other work.
const CPU_BUDGET_MILLISECONDS = 50;

test("renders the largest allowed narration document within the CPU budget", () => {
  // 50 characters of narration text, so 199 paragraphs of four sentences and their headings come
  // close to the limit.
  const sentence =
    'A sentence with <em>emphasis</em> and a <a href="/cited">cited source</a>, too. ';
  const paragraphHtml = `<p>${sentence.repeat(4)}</p>`;
  const narrationDocument = createNarrationDocument({
    sourceTitle: "The largest narration document",
    sourceMaterialHtml: Array.from(
      { length: MAX_SYNCHRONIZATION_UNITS - 1 },
      (_, index) => (index % 10 === 0 ? `<h2>Section ${index}</h2>` : "") + paragraphHtml,
    ).join(""),
  });
  const narrationCharacters = narrationDocument.synchronizationUnits
    .map(({ narrationText }) => narrationText.length)
    .reduce((sum, length) => sum + length, 0);

  expect(narrationDocument.synchronizationUnits).toHaveLength(MAX_SYNCHRONIZATION_UNITS);
  expect(narrationCharacters).toBeGreaterThan(MAX_NARRATION_CHARACTERS * 0.95);
  expect(narrationCharacters).toBeLessThanOrEqual(MAX_NARRATION_CHARACTERS);

  // The fastest of several renders, so a busy test machine doesn't fail the budget.
  const cpuMilliseconds = Array.from({ length: 5 }, () => {
    const cpuUsageBefore = process.cpuUsage();
    const rendered = renderNarrationDocument({
      narrationDocument,
      originalUrl: "https://publisher.example/articles/story",
    });
    const cpuUsage = process.cpuUsage(cpuUsageBefore);

    expect(rendered.mismatch).toBeUndefined();

    return (cpuUsage.user + cpuUsage.system) / 1000;
  });

  expect(Math.min(...cpuMilliseconds)).toBeLessThan(CPU_BUDGET_MILLISECONDS);
});

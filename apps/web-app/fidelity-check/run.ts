import { expect, test } from "@playwright/test";

import { readFidelityCheckEnvironment } from "#fidelity-check/inputs.ts";

import { checkAgainstDesign, formatFidelityReport, readDesignImageSize } from "@cup/fidelity-check";

const { story, designImagePath, ignoreTopPixels } = readFidelityCheckEnvironment(
  // oxlint-disable-next-line node/no-process-env -- The inputs cli.ts checked; this run has no other way to get them.
  process.env,
);

test.use({ viewport: readDesignImageSize(designImagePath), deviceScaleFactor: 3 });

test(`${story} matches the design`, async ({ mount, page }) => {
  await mount(story);
  await expect(page.getByRole("main", { includeHidden: true })).toBeVisible();

  const report = await checkAgainstDesign(page, {
    designImagePath,
    reportDirectory: "playwright-output/fidelity-check",
    ignoreTopPixels,
  });

  console.log(formatFidelityReport(report));
  expect(report.bands.filter(({ isWithinTolerance }) => !isWithinTolerance)).toEqual([]);
});

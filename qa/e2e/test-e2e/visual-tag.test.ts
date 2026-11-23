import { VISUAL_TAG } from "#test-e2e/browser-project-tags.ts";
import { expect, test } from "#test-e2e/fixtures.ts";

test("a screenshot assertion in a test without the visual tag fails, naming the tag", async ({
  browser,
}) => {
  const page = await browser.newPage();
  await page.setContent("<p>A test without the visual tag</p>");

  await expect(expect(page).toHaveScreenshot("untagged.png")).rejects.toThrow(
    'Tag a test that asserts a screenshot with "@visual"',
  );
  await page.close();
});

test(
  "a screenshot assertion in a test with the visual tag passes its options to Playwright",
  { tag: VISUAL_TAG },
  async ({ browser }) => {
    const page = await browser.newPage();
    await page.setContent("<p>A test with the visual tag</p>");

    await expect(expect(page).toHaveScreenshot({ maxDiffPixels: -1 })).rejects.toThrow(
      "`maxDiffPixels` option value must be non-negative integer",
    );
    await expect(
      expect(page.locator("p")).toHaveScreenshot("options.png", { maxDiffPixels: -1 }),
    ).rejects.toThrow("`maxDiffPixels` option value must be non-negative integer");
    await page.close();
  },
);

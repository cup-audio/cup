import {
  expect as baseExpect,
  test,
  type Locator,
  type Page,
  type PageAssertionsToHaveScreenshotOptions,
} from "@playwright/test";

export const VISUAL_TAG = "@visual";

export { test };

export const expect = baseExpect.extend({
  async toHaveScreenshot(
    receiver: Locator | Page,
    nameOrOptions?: ScreenshotName | ScreenshotOptions,
    options?: ScreenshotOptions,
  ) {
    if (!test.info().tags.includes(VISUAL_TAG)) {
      return {
        name: "toHaveScreenshot",
        pass: false,
        message: () =>
          `Tag a test that asserts a screenshot with "${VISUAL_TAG}", so that it runs in all four browser projects: test(title, { tag: "${VISUAL_TAG}" }, body).`,
      };
    }

    const assertions: ScreenshotAssertions = baseExpect(receiver);
    await (isScreenshotName(nameOrOptions)
      ? assertions.toHaveScreenshot(nameOrOptions, options)
      : assertions.toHaveScreenshot(nameOrOptions));
    return { name: "toHaveScreenshot", pass: true, message: () => "" };
  },
});

type ScreenshotName = string | ReadonlyArray<string>;

type ScreenshotOptions = PageAssertionsToHaveScreenshotOptions;

type ScreenshotAssertions = {
  toHaveScreenshot(name: ScreenshotName, options?: ScreenshotOptions): Promise<void>;
  toHaveScreenshot(options?: ScreenshotOptions): Promise<void>;
};

function isScreenshotName(
  nameOrOptions: ScreenshotName | ScreenshotOptions | undefined,
): nameOrOptions is ScreenshotName {
  return typeof nameOrOptions === "string" || Array.isArray(nameOrOptions);
}

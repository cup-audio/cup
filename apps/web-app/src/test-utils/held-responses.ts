import type { Page } from "@playwright/test";

export async function holdResponses(page: Page, name: string): Promise<void> {
  await callStoryFunction(page, "holdResponses", [name]);
}

export async function releaseResponses(page: Page, name: string): Promise<void> {
  await callStoryFunction(page, "releaseResponses", [name]);
}

export async function failResponses(page: Page, name: string, status: 403 | 404 | 500) {
  await callStoryFunction(page, "failResponses", [name, status]);
}

async function callStoryFunction(
  page: Page,
  functionName: string,
  storyArguments: readonly (string | number)[],
) {
  await page.evaluate(
    ([storyFunctionName, argumentsOfCall]) => {
      const storyFunction: unknown = Reflect.get(window, storyFunctionName);
      if (typeof storyFunction !== "function") {
        throw new TypeError(`The story offers no ${storyFunctionName}`);
      }
      Reflect.apply(storyFunction, window, argumentsOfCall);
    },
    [functionName, storyArguments] as const,
  );
}

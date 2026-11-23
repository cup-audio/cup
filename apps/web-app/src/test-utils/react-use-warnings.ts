import type { Page } from "@playwright/test";

export function recordReactUseWarnings(page: Page): string[] {
  const warnings: string[] = [];
  page.on("console", (message) => {
    if (message.text().includes("https://react.dev/warnings/conditional-use-of-use")) {
      warnings.push(message.text());
    }
  });

  return warnings;
}

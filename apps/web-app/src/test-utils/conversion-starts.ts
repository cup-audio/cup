import type { Page } from "@playwright/test";

export function recordConversionStarts(page: Page): string[] {
  const starts: string[] = [];
  page.on("request", (request) => {
    if (request.method() !== "POST" || !new URL(request.url()).pathname.endsWith("/conversions")) {
      return;
    }
    const body: unknown = request.postDataJSON();
    if (
      typeof body !== "object" ||
      body === null ||
      !("sourceUrl" in body) ||
      typeof body.sourceUrl !== "string"
    ) {
      throw new TypeError(`A conversion start carried no source URL: ${request.postData()}`);
    }
    starts.push(body.sourceUrl);
  });
  return starts;
}

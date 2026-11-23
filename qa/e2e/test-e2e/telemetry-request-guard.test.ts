import { test } from "#test-e2e/fixtures.ts";

for (const telemetryUrl of [
  "https://o1.ingest.de.sentry.io/api/1/envelope/",
  "https://app.example.test/_/e",
]) {
  test(`a test whose page requests ${telemetryUrl} fails`, async ({ browser }) => {
    test.fail();
    const page = await browser.newPage();
    await page.route(telemetryUrl, (route) => route.fulfill({ status: 200 }));
    await page.setContent(`<img src="${telemetryUrl}">`);
    await page.close();
  });
}

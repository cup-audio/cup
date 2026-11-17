import { test } from "#test-e2e/fixtures.ts";

for (const telemetryUrl of [
  "https://o1.ingest.de.sentry.io/api/1/envelope/",
  "https://app.example.test/_/e",
]) {
  test(`a test whose page requests ${telemetryUrl} fails`, async ({ browser }) => {
    // The telemetry request guard fails this test in its teardown; the test proves that it does.
    test.fail();
    // A page of its own, so that the test starts no test Worker for the fixture's page.
    const page = await browser.newPage();
    // Answered locally: nothing reaches Sentry, and the page logs no failed request.
    await page.route(telemetryUrl, (route) => route.fulfill({ status: 200 }));
    await page.setContent(`<img src="${telemetryUrl}">`);
    await page.close();
  });
}

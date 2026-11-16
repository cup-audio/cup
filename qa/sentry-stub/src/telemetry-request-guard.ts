import { expect, type Browser, type BrowserContext, type Fixtures } from "@playwright/test";

/** The path of the telemetry tunnel on the Worker. */
const TUNNEL_PATH = "/_/e";

/**
 * Whether `url` is a request a web E2E page must never make: to one of Sentry's hosts, or to the
 * telemetry tunnel on any origin.
 */
export function isTelemetryRequest(url: string): boolean {
  const { hostname, pathname } = new URL(url);
  return hostname === "sentry.io" || hostname.endsWith(".sentry.io") || pathname === TUNNEL_PATH;
}

/**
 * An automatic Playwright fixture that fails every test whose pages request Sentry or the telemetry
 * tunnel, so a regression in the web app's on/off rule fails the web E2E suites. It watches every
 * browser context the test opens, the `page` fixture's and those of `browser.newPage()` alike, and
 * records requests before any route answers or aborts them.
 *
 * Extend a suite's `test` with it: `base.extend(telemetryRequestGuard)`.
 */
export const telemetryRequestGuard: Fixtures<
  { forbidTelemetryRequests: void },
  object,
  object,
  { browser: Browser }
> = {
  forbidTelemetryRequests: [
    async ({ browser }, use) => {
      const telemetryRequests: string[] = [];
      const watch = (context: BrowserContext) => {
        context.on("request", (request) => {
          if (isTelemetryRequest(request.url())) {
            telemetryRequests.push(request.url());
          }
        });
      };

      // Shadows the prototype's method for this test; `browser.newPage()` calls it too.
      const newContext = browser.newContext.bind(browser);
      browser.newContext = async (...parameters) => {
        const context = await newContext(...parameters);
        watch(context);
        return context;
      };
      for (const context of browser.contexts()) {
        watch(context);
      }

      try {
        await use();
      } finally {
        Reflect.deleteProperty(browser, "newContext");
      }

      expect(telemetryRequests, "A page requested Sentry or the telemetry tunnel").toEqual([]);
    },
    { auto: true },
  ],
};

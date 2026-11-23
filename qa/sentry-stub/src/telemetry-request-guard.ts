import { expect, type Browser, type BrowserContext, type Fixtures } from "@playwright/test";

const TUNNEL_PATH = "/_/e";

export function isTelemetryRequest(url: string): boolean {
  const { hostname, pathname } = new URL(url);
  return hostname === "sentry.io" || hostname.endsWith(".sentry.io") || pathname === TUNNEL_PATH;
}

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

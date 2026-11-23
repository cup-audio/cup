import { expect } from "vitest";

import type { SentryErrorEvent } from "@cup/sentry-stub";

import type { MobileApp } from "#src/fixtures.ts";
import { waitFor } from "#src/host.ts";

const CLIENT_IP_HEADERS = [
  "cf-connecting-ip",
  "x-forwarded-for",
  "x-real-ip",
  "x-sentry-forwarded-for",
];
export const SENTRY_EVENT_TIMEOUT_MS = 30_000;
const NATIVE_SEND_GRACE_MS = 5_000;
const JS_ERROR_RETRY_MS = 3_000;

type SentryCapacitorGlobal = { Plugins: { SentryCapacitor: { crash(): Promise<void> } } };

export async function expectJsErrorThroughTunnel(
  app: MobileApp,
  webView: WebdriverIO.Browser,
  accountId: string,
  message = "mobile-e2e shell JS error",
): Promise<void> {
  const hasArrived = () =>
    app.sentryStub
      .errorEvents("cup-app")
      .some((event) => hasException(event, message) && event.user?.["id"] === accountId);
  let attempt = 0;
  let lastAttemptMs = Number.NEGATIVE_INFINITY;
  await waitFor(
    "the shell's JS error with the account ID at the Sentry stub",
    async () => {
      if (hasArrived()) {
        return true;
      }
      if (performance.now() - lastAttemptMs >= JS_ERROR_RETRY_MS) {
        attempt++;
        lastAttemptMs = performance.now();
        await webView.execute((errorMessage) => {
          setTimeout(() => {
            throw new Error(errorMessage);
          });
        }, `${message} (attempt ${attempt})`);
      }
      return undefined;
    },
    SENTRY_EVENT_TIMEOUT_MS,
  );
  const event = app.sentryStub.errorEvents("cup-app").find((item) => hasException(item, message));
  const envelope = app.sentryStub.envelopes.find(
    ({ header }) => header["event_id"] === event?.event_id,
  );
  expect(envelope).toBeDefined();
  for (const header of CLIENT_IP_HEADERS) {
    expect(envelope?.requestHeaders).not.toHaveProperty(header);
  }
  expect(app.worker.requests()).toContainEqual(
    expect.objectContaining({ method: "POST", path: "/_/e" }),
  );
}

export async function crashNatively(webView: WebdriverIO.Browser): Promise<void> {
  await webView.execute(() => {
    setTimeout(() => {
      const capacitor: SentryCapacitorGlobal = Reflect.get(window, "Capacitor");
      void capacitor.Plugins.SentryCapacitor.crash();
    }, 100);
  });
}

export async function turnCrashReportsOff(webView: WebdriverIO.Browser): Promise<void> {
  await webView.$('a[aria-label="Account"]').click();
  const crashReports = webView.$('input[role="switch"]');
  await crashReports.waitForEnabled({ timeout: 30_000 });
  expect(await crashReports.isSelected()).toBe(true);
  await crashReports.click();
  await webView.waitUntil(
    async () => !(await crashReports.isSelected()) && (await crashReports.isEnabled()),
    { timeout: 10_000, timeoutMsg: "The crash reports switch did not turn off." },
  );
}

export async function expectNoNativeEvents(
  app: MobileApp,
  webView: WebdriverIO.Browser,
  accountId: string,
  eventCountBeforeCrash: number,
): Promise<void> {
  await expectJsErrorThroughTunnel(app, webView, accountId, "mobile-e2e JS error after the crash");
  await new Promise((resolve) => setTimeout(resolve, NATIVE_SEND_GRACE_MS));
  expect(
    app.sentryStub
      .errorEvents("cup-app")
      .slice(eventCountBeforeCrash)
      .filter((event) => event["platform"] !== "javascript")
      .map(({ event_id: eventId, platform }) => ({ eventId, platform })),
  ).toEqual([]);
}

export async function readAccountId(app: MobileApp): Promise<string> {
  const authorization = await waitFor(
    "a request of the app with a bearer token",
    async () =>
      app.worker
        .requests()
        .findLast(({ headers }) => headers["authorization"]?.startsWith("Bearer ") === true)
        ?.headers["authorization"],
    10_000,
  );
  const response = await fetch(`${app.worker.origin}/api/account`, {
    headers: { authorization },
  });
  const body: unknown = await response.json();
  const accountId: unknown =
    typeof body === "object" && body !== null ? Reflect.get(body, "accountId") : undefined;
  if (!response.ok || typeof accountId !== "string") {
    throw new Error(`Reading the account failed with ${response.status}.`);
  }
  return accountId;
}

export function distinctEvents(events: SentryErrorEvent[]): SentryErrorEvent[] {
  const seen = new Set<string | undefined>();
  return events.filter(({ event_id: eventId }) => {
    if (eventId !== undefined && seen.has(eventId)) {
      return false;
    }
    seen.add(eventId);
    return true;
  });
}

export function hasException(event: SentryErrorEvent, message: string): boolean {
  return (event.exception?.values ?? []).some(({ value }) => value?.includes(message) === true);
}

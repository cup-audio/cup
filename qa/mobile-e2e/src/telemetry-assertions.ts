import { expect } from "vitest";

import type { SentryErrorEvent } from "@cup/sentry-stub";

import type { MobileApp } from "#src/fixtures.ts";
import { waitFor } from "#src/host.ts";

/** The headers that would carry the device's IP address to Sentry. */
const CLIENT_IP_HEADERS = [
  "cf-connecting-ip",
  "x-forwarded-for",
  "x-real-ip",
  "x-sentry-forwarded-for",
];
/** How long a test waits for an event to reach the stub. */
export const SENTRY_EVENT_TIMEOUT_MS = 30_000;
/** How long a test waits for a native event it expects not to arrive. */
const NATIVE_SEND_GRACE_MS = 5_000;
/** How long a test waits for a thrown JS error before throwing it again. */
const JS_ERROR_RETRY_MS = 3_000;

/** The part of the page's `window.Capacitor` the tests call. */
type SentryCapacitorGlobal = { Plugins: { SentryCapacitor: { crash(): Promise<void> } } };

/**
 * Throws a JS error in the WebView and checks that it reaches the stub with `accountId` as its
 * user, through the test Worker's telemetry tunnel, which strips the client's IP headers. A test
 * that throws more than one passes a `message` of its own to each.
 */
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
  // Right after a launch, the user rule has not loaded the account ID yet, and an error thrown then
  // carries the user `signed-out`; so the error is thrown again until one arrives with the ID. Each
  // attempt has its own message, because Sentry drops an error that repeats the one before it.
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

/**
 * Crashes Cup natively through the Sentry plugin's own test hook, which nothing in Cup's process
 * catches. The hook runs after the script has returned: on iOS, Appium otherwise waits two minutes
 * for the answer of a page whose process has died.
 */
export async function crashNatively(webView: WebdriverIO.Browser): Promise<void> {
  await webView.execute(() => {
    setTimeout(() => {
      const capacitor: SentryCapacitorGlobal = Reflect.get(window, "Capacitor");
      void capacitor.Plugins.SentryCapacitor.crash();
    }, 100);
  });
}

/**
 * From Recents, opens the account dialog and turns its "Send crash reports" switch off, which is on
 * by default. Returns once the shell has stored the switch and deleted Sentry's files.
 */
export async function turnCrashReportsOff(webView: WebdriverIO.Browser): Promise<void> {
  await webView.$('a[aria-label="Account"]').click();
  const crashReports = webView.$('input[role="switch"]');
  await crashReports.waitForEnabled({ timeout: 30_000 });
  expect(await crashReports.isSelected()).toBe(true);
  await crashReports.click();
  // The switch is disabled while the plugin stores it.
  await webView.waitUntil(
    async () => !(await crashReports.isSelected()) && (await crashReports.isEnabled()),
    { timeout: 10_000, timeoutMsg: "The crash reports switch did not turn off." },
  );
}

/**
 * Checks that a JS-only shell, whose listener turned crash reports off, sends nothing from a native
 * SDK after a native crash and the launch after it, among the events after the first
 * `eventCountBeforeCrash`. A thrown JS error, which goes through the plugin queue after the native
 * SDK would have started, tells that the relaunched Cup reports again; the grace period after it
 * covers a native send still in flight.
 */
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

/** The account ID of the signed-in listener, read from the test Worker with the app's token. */
export async function readAccountId(app: MobileApp): Promise<string> {
  // Recents can show before the app's first request with the token has reached the Worker.
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

/**
 * `events` with only the first of each event ID. A native SDK can send a crash once while the
 * process ends and again from disk on the next launch; Sentry drops the second.
 */
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

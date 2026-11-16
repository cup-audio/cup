import { expect } from "vitest";

import type { SentryErrorEvent } from "@cup/sentry-stub";

import type { MobileApp } from "#src/fixtures.ts";

/** The headers that would carry the device's IP address to Sentry. */
const CLIENT_IP_HEADERS = [
  "cf-connecting-ip",
  "x-forwarded-for",
  "x-real-ip",
  "x-sentry-forwarded-for",
];
/** How long a test waits for an event to reach the stub. */
export const SENTRY_EVENT_TIMEOUT_MS = 30_000;

/** The part of the page's `window.Capacitor` the tests call. */
type SentryCapacitorGlobal = { Plugins: { SentryCapacitor: { crash(): Promise<void> } } };

/**
 * Throws a JS error in the WebView and checks that it reaches the stub with `accountId` as its
 * user, through the test Worker's telemetry tunnel, which strips the client's IP headers.
 */
export async function expectJsErrorThroughTunnel(
  app: MobileApp,
  webView: WebdriverIO.Browser,
  accountId: string,
): Promise<void> {
  const message = "mobile-e2e shell JS error";
  await webView.execute((errorMessage) => {
    setTimeout(() => {
      throw new Error(errorMessage);
    });
  }, message);
  await app.sentryStub.waitFor(
    "the shell's JS error with the account ID",
    () =>
      app.sentryStub
        .errorEvents("cup-app")
        .some((event) => hasException(event, message) && event.user?.["id"] === accountId),
    { timeoutMs: SENTRY_EVENT_TIMEOUT_MS },
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

/** The account ID of the signed-in listener, read from the test Worker with the app's token. */
export async function readAccountId(app: MobileApp): Promise<string> {
  const authorization = app.worker
    .requests()
    .findLast(({ headers }) => headers["authorization"]?.startsWith("Bearer ") === true)?.headers[
    "authorization"
  ];
  if (authorization === undefined) {
    throw new Error("The app sent no request with a bearer token.");
  }
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

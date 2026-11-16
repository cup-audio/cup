import { test } from "vitest";

import { useSentryStub, type SentryStub } from "@cup/sentry-stub";

import { useWorker } from "#test/use-worker.ts";

const TUNNEL_URL = "https://cup.audio/_/e";

/** An envelope as the client SDK sends it: one error event of a signed-out listener. */
function eventEnvelope(dsn: string, eventId: string): string {
  return [
    JSON.stringify({ event_id: eventId, dsn, sent_at: "2026-11-16T12:00:00.000Z" }),
    JSON.stringify({ type: "event" }),
    JSON.stringify({
      event_id: eventId,
      level: "error",
      user: { id: "signed-out", ip_address: null, geo: { city: "Graz", country_code: "DE" } },
    }),
  ].join("\n");
}

/** Waits for the `http.server` span of the tunnel request, which the Worker sends to `cup-worker`. */
async function waitForTunnelRequestSpan(sentry: SentryStub): Promise<void> {
  await sentry.waitFor("the http.server span of /_/e", () =>
    sentry
      .spans("cup-worker")
      .some(
        (span) =>
          span.attributes["sentry.op"]?.value === "http.server" &&
          span.attributes["url.path"]?.value === "/_/e",
      ),
  );
}

test("the tunnel forwards an allowlisted envelope with the listener's country and without their IP", async ({
  expect,
  onTestFinished,
}) => {
  const sentry = await useSentryStub({ onTestFinished });
  const worker = await useWorker({
    onTestFinished,
    sentryDsn: sentry.dsn("cup-worker"),
    vars: { SENTRY_TUNNEL_DSNS: sentry.dsn("cup-app") },
  });

  const response = await worker.fetch(TUNNEL_URL, {
    method: "POST",
    headers: {
      "Content-Type": "text/plain;charset=UTF-8",
      Origin: "capacitor://localhost",
      "CF-Connecting-IP": "203.0.113.7",
      "X-Forwarded-For": "203.0.113.7",
      "X-Real-IP": "203.0.113.7",
    },
    body: eventEnvelope(sentry.dsn("cup-app"), "a0000000000000000000000000000001"),
    cf: { country: "AT" },
  });

  expect(response.status).toBe(200);
  expect(response.headers.get("Access-Control-Allow-Origin")).toBe("capacitor://localhost");
  await sentry.waitFor("the tunnelled event", () => sentry.errorEvents("cup-app").length > 0);
  const [envelope] = sentry.envelopes.filter((entry) => entry.project === "cup-app");
  expect(envelope?.items[0]?.payload).toMatchObject({
    event_id: "a0000000000000000000000000000001",
    user: { id: "signed-out", ip_address: null, geo: { country_code: "AT" } },
  });
  for (const ipHeader of [
    "x-sentry-forwarded-for",
    "cf-connecting-ip",
    "x-forwarded-for",
    "x-real-ip",
  ]) {
    expect(envelope?.requestHeaders).not.toHaveProperty(ipHeader);
  }
  expect(JSON.stringify(envelope)).not.toContain("203.0.113.7");
});

test("the tunnel rejects any DSN that is not allowlisted, the Worker's own included", async ({
  expect,
  onTestFinished,
}) => {
  const sentry = await useSentryStub({ onTestFinished });
  const worker = await useWorker({
    onTestFinished,
    sentryDsn: sentry.dsn("cup-worker"),
    vars: { SENTRY_TUNNEL_DSNS: sentry.dsn("cup-app") },
  });

  const response = await worker.fetch(TUNNEL_URL, {
    method: "POST",
    body: eventEnvelope(sentry.dsn("cup-worker"), "b0000000000000000000000000000002"),
  });

  expect(response.status).toBe(403);
  await waitForTunnelRequestSpan(sentry);
  expect(sentry.errorEvents("cup-worker")).toEqual([]);
});

test("without an allowlist, the tunnel forwards nothing", async ({ expect, onTestFinished }) => {
  const sentry = await useSentryStub({ onTestFinished });
  const worker = await useWorker({ onTestFinished, sentryDsn: sentry.dsn("cup-worker") });

  const response = await worker.fetch(TUNNEL_URL, {
    method: "POST",
    body: eventEnvelope(sentry.dsn("cup-app"), "c0000000000000000000000000000003"),
  });

  expect(response.status).toBe(403);
  await waitForTunnelRequestSpan(sentry);
  expect(sentry.errorEvents("cup-app")).toEqual([]);
});

test("the tunnel answers a CORS preflight from the app shells", async ({
  expect,
  onTestFinished,
}) => {
  const worker = await useWorker({ onTestFinished });

  const response = await worker.fetch(TUNNEL_URL, {
    method: "OPTIONS",
    headers: {
      Origin: "https://localhost",
      "Access-Control-Request-Method": "POST",
      "Access-Control-Request-Headers": "content-type",
    },
  });

  expect(response.status).toBe(204);
  expect(response.headers.get("Access-Control-Allow-Origin")).toBe("https://localhost");
  expect(response.headers.get("Access-Control-Allow-Methods")).toContain("POST");
});

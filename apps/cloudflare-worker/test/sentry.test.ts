import { test } from "vitest";

import { errorResponseSchema } from "@cup/listener-api.routes";
import { LOCAL_OPERATOR_ACCESS_TOKEN } from "@cup/operator-api.routes";
import { useSentryStub, type SentryLog, type SentryStub } from "@cup/sentry-stub";

import { useWorker } from "#test/use-worker.ts";

/**
 * A well-formed media URL token. With an empty signing key, checking its signature throws, which
 * the Listener API answers with a 500: a misconfiguration every test can provoke.
 */
const MEDIA_PATH = "/api/files/audiobooks/c1/cover-image";
const MEDIA_URL = `https://cup.audio${MEDIA_PATH}?token=v1.eyJhIjoxfQ.AAAA`;

function isOperatorMutation(log: SentryLog): boolean {
  return log.attributes["event.name"]?.value === "operator-mutation";
}

/**
 * Waits for the request's `http.server` span. Sentry sends it in the flush at the end of the
 * invocation, together with any error event the request captured.
 */
async function waitForRequestSpan(sentry: SentryStub, path: string): Promise<void> {
  await sentry.waitFor(`the http.server span of ${path}`, () =>
    sentry
      .spans("cup-worker")
      .some(
        (span) =>
          span.attributes["sentry.op"]?.value === "http.server" &&
          span.attributes["url.path"]?.value === path,
      ),
  );
}

test("a 500 sends exactly one error event, without the media token", async ({
  expect,
  onTestFinished,
}) => {
  const sentry = await useSentryStub({ onTestFinished });
  const worker = await useWorker({
    onTestFinished,
    sentryDsn: sentry.dsn("cup-worker"),
    secrets: { MEDIA_URL_SIGNING_KEY: "" },
  });

  const response = await worker.fetch(MEDIA_URL);

  expect(response.status).toBe(500);
  await sentry.waitFor("an error event", () => sentry.errorEvents("cup-worker").length > 0);
  await waitForRequestSpan(sentry, MEDIA_PATH);
  const events = sentry.errorEvents("cup-worker");
  expect(events).toHaveLength(1);
  expect(events[0]).toMatchObject({
    level: "error",
    environment: "production",
    release: expect.any(String),
    tags: { "cup.component": "fetch" },
    user: { ip_address: null },
    request: { url: `https://cup.audio${MEDIA_PATH}?token=[Filtered]` },
    exception: { values: [{ type: "Error", value: "MEDIA_URL_SIGNING_KEY must not be empty." }] },
  });
  expect(JSON.stringify(events[0])).not.toContain("eyJhIjoxfQ");
});

test("a 500's body carries the trace ID of the event Sentry receives", async ({
  expect,
  onTestFinished,
}) => {
  const sentry = await useSentryStub({ onTestFinished });
  const worker = await useWorker({
    onTestFinished,
    sentryDsn: sentry.dsn("cup-worker"),
    secrets: { MEDIA_URL_SIGNING_KEY: "" },
  });

  const response = await worker.fetch(MEDIA_URL);

  expect(response.status).toBe(500);
  // The contract requires a 32-hex trace ID.
  const body = errorResponseSchema.parse(await response.json());
  await sentry.waitFor("an error event", () => sentry.errorEvents("cup-worker").length > 0);
  const [event] = sentry.errorEvents("cup-worker");
  expect(event?.contexts?.["trace"]?.["trace_id"]).toBe(body.error.traceId);
});

test("a 4xx sends no error event", async ({ expect, onTestFinished }) => {
  const sentry = await useSentryStub({ onTestFinished });
  const worker = await useWorker({ onTestFinished, sentryDsn: sentry.dsn("cup-worker") });

  const response = await worker.fetch(`https://cup.audio${MEDIA_PATH}?token=v2.unknown`);

  expect(response.status).toBe(401);
  await waitForRequestSpan(sentry, MEDIA_PATH);
  expect(sentry.errorEvents("cup-worker")).toEqual([]);
});

test("a malformed JSON body answers 400 and sends no error event", async ({
  expect,
  onTestFinished,
}) => {
  const sentry = await useSentryStub({ onTestFinished });
  const worker = await useWorker({ onTestFinished, sentryDsn: sentry.dsn("cup-worker") });

  // Hono's JSON validator throws its own 400 HTTPException, which the API answers as it is.
  const response = await worker.fetch("http://localhost/api/operator/grants", {
    method: "POST",
    headers: { "Cf-Access-Token": LOCAL_OPERATOR_ACCESS_TOKEN, "Content-Type": "application/json" },
    body: "{not json",
  });

  expect(response.status).toBe(400);
  expect(errorResponseSchema.parse(await response.json()).error.code).toBe("invalid-input");
  await waitForRequestSpan(sentry, "/api/operator/grants");
  expect(sentry.errorEvents("cup-worker")).toEqual([]);
});

test("GET /api/health answers 200 and sends no trace", async ({ expect, onTestFinished }) => {
  const sentry = await useSentryStub({ onTestFinished });
  const worker = await useWorker({ onTestFinished, sentryDsn: sentry.dsn("cup-worker") });

  const response = await worker.fetch("https://cup.audio/api/health");

  expect(response.status).toBe(200);
  expect(await response.json()).toEqual({ status: "ok" });
  // An unsampled request sends nothing to wait for. A traced request made afterwards flushes after
  // the health check's own flush would have, so its span marks the point to assert at.
  await worker.fetch(`https://cup.audio${MEDIA_PATH}?token=v2.unknown`);
  await waitForRequestSpan(sentry, MEDIA_PATH);
  expect(
    sentry
      .spans("cup-worker")
      .filter((span) => span.attributes["url.path"]?.value === "/api/health"),
  ).toEqual([]);
});

test("an operator mutation's log record carries its error body's trace ID, and no email", async ({
  expect,
  onTestFinished,
}) => {
  const sentry = await useSentryStub({ onTestFinished });
  const worker = await useWorker({ onTestFinished, sentryDsn: sentry.dsn("cup-worker") });

  // A grant without a label fails validation: a 400 whose body carries the request's trace ID.
  const response = await worker.fetch("http://localhost/api/operator/grants", {
    method: "POST",
    headers: { "Cf-Access-Token": LOCAL_OPERATOR_ACCESS_TOKEN, "Content-Type": "application/json" },
    body: JSON.stringify({ requestId: "4a0c2b4e-8f5d-4c39-9a51-0d7f3c2e6b18" }),
  });

  expect(response.status).toBe(400);
  const body = errorResponseSchema.parse(await response.json());
  await sentry.waitFor("the operator-mutation log record", () =>
    sentry.logs("cup-worker").some(isOperatorMutation),
  );
  const record = sentry.logs("cup-worker").find(isOperatorMutation);
  expect(record?.trace_id).toBe(body.error.traceId);
  expect(JSON.stringify(record)).not.toContain("@");
});

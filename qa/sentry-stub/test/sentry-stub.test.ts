import { expect, test } from "vitest";

import { useSentryStub } from "#src/sentry-stub.ts";

/** Posts an envelope the way Sentry's SDKs do: to the DSN's project, keyed by its public key. */
async function postEnvelope(dsn: string, body: string): Promise<Response> {
  const { username, origin, pathname } = new URL(dsn);
  return fetch(`${origin}/api${pathname}/envelope/?sentry_version=7&sentry_key=${username}`, {
    method: "POST",
    headers: { "Content-Type": "application/x-sentry-envelope", "X-Forwarded-For": "203.0.113.7" },
    body,
  });
}

test("records an envelope with its project, headers and items, by length or by newline", async ({
  onTestFinished,
}) => {
  const stub = await useSentryStub({ onTestFinished });
  const event = JSON.stringify({
    event_id: "a".repeat(32),
    level: "error",
    message: "Grüße aus Wien",
  });
  const body = [
    JSON.stringify({ event_id: "a".repeat(32), dsn: stub.dsn("cup-worker") }),
    // A declared length counts bytes, not characters.
    JSON.stringify({ type: "event", length: Buffer.byteLength(event) }),
    event,
    JSON.stringify({ type: "client_report" }),
    JSON.stringify({ discarded_events: [] }),
  ].join("\n");

  const response = await postEnvelope(stub.dsn("cup-worker"), body);

  expect(response.status).toBe(200);
  expect(stub.envelopes).toEqual([
    {
      project: "cup-worker",
      publicKey: "public",
      requestHeaders: expect.objectContaining({ "x-forwarded-for": "203.0.113.7" }),
      header: { event_id: "a".repeat(32), dsn: stub.dsn("cup-worker") },
      items: [
        { header: { type: "event", length: Buffer.byteLength(event) }, payload: JSON.parse(event) },
        { header: { type: "client_report" }, payload: { discarded_events: [] } },
      ],
    },
  ]);
  expect(stub.errorEvents("cup-worker")).toEqual([JSON.parse(event)]);
  expect(stub.errorEvents("cup-app")).toEqual([]);
});

test("lists the streamed spans of a project", async ({ onTestFinished }) => {
  const stub = await useSentryStub({ onTestFinished });
  const span = {
    name: "GET",
    trace_id: "b".repeat(32),
    span_id: "c".repeat(16),
    is_segment: true,
    status: "ok",
    attributes: { "url.path": { value: "/api/health", type: "string" } },
  };
  const body = [
    JSON.stringify({}),
    JSON.stringify({ type: "span", item_count: 1 }),
    JSON.stringify({ version: 2, items: [span] }),
  ].join("\n");

  await postEnvelope(stub.dsn("cup-worker"), body);

  expect(stub.spans("cup-worker")).toEqual([span]);
  expect(stub.errorEvents("cup-worker")).toEqual([]);
});

test("lists the log records of a project", async ({ onTestFinished }) => {
  const stub = await useSentryStub({ onTestFinished });
  const log = {
    timestamp: 1_800_000_000,
    level: "warn",
    body: "The cover image could not be stored.",
    attributes: { "event.name": { value: "cover-image-unavailable", type: "string" } },
  };
  const body = [
    JSON.stringify({}),
    JSON.stringify({ type: "log", item_count: 1 }),
    JSON.stringify({ items: [log] }),
  ].join("\n");

  await postEnvelope(stub.dsn("cup-worker"), body);

  expect(stub.logs("cup-worker")).toEqual([log]);
  expect(stub.logs("cup-app")).toEqual([]);
});

test("answers 404 to a project it does not know, and records nothing", async ({
  onTestFinished,
}) => {
  const stub = await useSentryStub({ onTestFinished });

  const response = await postEnvelope(`http://public@${new URL(stub.url).host}/999`, "{}\n");

  expect(response.status).toBe(404);
  expect(stub.envelopes).toEqual([]);
});

test("waitFor resolves once an envelope arrives and fails with its description on timeout", async ({
  onTestFinished,
}) => {
  const stub = await useSentryStub({ onTestFinished });
  const arrived = stub.waitFor("an envelope", () => stub.envelopes.length === 1);

  await postEnvelope(stub.dsn("cup-app"), "{}\n");

  await expect(arrived).resolves.toBeUndefined();
  await expect(stub.waitFor("a second envelope", () => false, { timeoutMs: 50 })).rejects.toThrow(
    "The Sentry stub did not receive a second envelope within 50 ms.",
  );
});

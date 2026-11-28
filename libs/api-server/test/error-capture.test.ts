import { afterEach, beforeEach, expect, test } from "vitest";

import { createApiServer } from "#src/api-server.ts";

import { recordSentry, stopRecordingSentry, type SentryRecorder } from "#test/sentry-recorder.ts";

const grantId = "0b3c9a4e-6f1d-4c2a-9e7b-5d8f1a2c3b4e";
const sessionsUrl = `https://cup.audio/api/grants/${grantId}/sessions`;
const browserMutation = {
  "Content-Type": "application/json",
  "X-Create-Audiobook-From-URL-Request": "1",
};

let sentry: SentryRecorder;

beforeEach(() => {
  sentry = recordSentry();
});

afterEach(() => {
  stopRecordingSentry();
});

function environment(exchangeCredential: () => Promise<unknown>) {
  return {
    SUPABASE_URL: "https://error-capture.supabase.co",
    CONVERSION_GRANTS: { idFromName: (name: string) => name, get: () => ({ exchangeCredential }) },
  };
}

test("a session exchange whose grant fails answers 503 and captures the error", async () => {
  const failure = new Error("Grant storage unavailable");

  const response = await createApiServer().request(
    sessionsUrl,
    {
      method: "POST",
      headers: browserMutation,
      body: JSON.stringify({ credential: `v1.${"a".repeat(43)}` }),
    },
    environment(async () => {
      throw failure;
    }),
  );

  expect(response.status).toBe(503);
  expect(sentry.exceptions).toEqual([failure]);
});

test("a malformed JSON body answers 400 and captures nothing", async () => {
  const response = await createApiServer().request(
    sessionsUrl,
    { method: "POST", headers: browserMutation, body: "{not json" },
    environment(async () => {
      throw new Error("The grant must not be called");
    }),
  );

  expect(response.status).toBe(400);
  expect(await response.json()).toMatchObject({ error: { code: "invalid-input" } });
  expect(sentry.exceptions).toEqual([]);
});

test("an error thrown before the routes, in the security headers, answers 500 with the trace ID", async () => {
  const response = await createApiServer().request("https://cup.audio/api/health", {}, {});

  expect(response.status).toBe(500);
  expect(await response.json()).toMatchObject({
    error: { code: "operational-error", traceId: expect.stringMatching(/^[0-9a-f]{32}$/) },
  });
  expect(sentry.exceptions).toHaveLength(1);
});

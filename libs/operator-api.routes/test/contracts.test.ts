import { describe, expect, test } from "vitest";

import {
  createGrantRequestSchema,
  errorResponseSchema,
  grantParamsSchema,
  invalidateSessionsRequestSchema,
} from "#src/contracts.ts";

const UUID = "b4ad28a8-bbd7-46af-a17c-59527becd745";
const TRACE_ID = "0af7651916cd43dd8448eb211c80319c";

describe("operator transport contracts", () => {
  test("accepts lowercase UUIDv4 only", () => {
    expect(grantParamsSchema.safeParse({ grantId: UUID }).success).toBe(true);
    expect(grantParamsSchema.safeParse({ grantId: UUID.toUpperCase() }).success).toBe(false);
  });

  test.each([
    [grantParamsSchema, { grantId: UUID, extra: true }],
    [createGrantRequestSchema, { label: "Label", requestId: UUID, extra: true }],
  ])("rejects unknown request fields", (schema, value) => {
    expect(schema.safeParse(value).success).toBe(false);
  });

  test("counts label and invalidation limits as Unicode code points", () => {
    expect(
      createGrantRequestSchema.safeParse({ label: "😀".repeat(120), requestId: UUID }).success,
    ).toBe(true);
    expect(
      createGrantRequestSchema.safeParse({ label: "😀".repeat(121), requestId: UUID }).success,
    ).toBe(false);
    expect(invalidateSessionsRequestSchema.safeParse({ reason: "😀".repeat(501) }).success).toBe(
      false,
    );
  });

  test("error envelopes carry the request's trace ID", () => {
    const error = { code: "operational-error", message: "Failed." };
    expect(errorResponseSchema.safeParse({ error: { ...error, traceId: TRACE_ID } }).success).toBe(
      true,
    );
    expect(errorResponseSchema.safeParse({ error: { ...error, traceId: UUID } }).success).toBe(
      false,
    );
    expect(errorResponseSchema.safeParse({ error: { ...error, requestId: UUID } }).success).toBe(
      false,
    );
  });
});

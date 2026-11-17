import { expect, test } from "vitest";

import { isTelemetryRequest } from "#src/telemetry-request-guard.ts";

test.each([
  "https://o4512441473040384.ingest.de.sentry.io/api/4512441485623376/envelope/",
  "https://sentry.io/api/0/",
  "https://cup.audio/_/e",
  "https://localhost:8443/_/e?sentry_key=public",
])("a request to %s is telemetry", (url) => {
  expect(isTelemetryRequest(url)).toBe(true);
});

test.each([
  "https://localhost:8443/api/health",
  "https://localhost:8443/_/events",
  "https://notsentry.io/",
  "https://sentry.io.example/",
  "https://cup.audio/app/recent",
])("a request to %s is not telemetry", (url) => {
  expect(isTelemetryRequest(url)).toBe(false);
});

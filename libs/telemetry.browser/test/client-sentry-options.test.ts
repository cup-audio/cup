import { expect, test } from "vitest";

import { CUP_APP_DSN } from "@cup/telemetry.core";

import { createClientSentryOptions } from "#src/client-sentry-options.ts";

const ROUTER = { subscribe: () => () => undefined };

test("the browser sends to cup-app through the tunnel on https://cup.audio", () => {
  const options = createClientSentryOptions({
    pageOrigin: "https://cup.audio",
    apiOrigin: "https://cup.audio",
    release: "web@0123456789abcdef",
    router: ROUTER,
  });

  expect(options?.dsn).toBe(CUP_APP_DSN);
  expect(options?.tunnel).toBe("https://cup.audio/_/e");
  expect(options?.release).toBe("web@0123456789abcdef");
});

test.each([
  "http://cup.audio",
  "https://www.cup.audio",
  "https://cup.audio.example",
  "https://localhost:8443",
  "http://127.0.0.1:5173",
  "capacitor://localhost",
  "null",
])("the browser sends nothing on %s", (pageOrigin) => {
  expect(
    createClientSentryOptions({
      pageOrigin,
      apiOrigin: pageOrigin,
      release: undefined,
      router: ROUTER,
    }),
  ).toBeUndefined();
});

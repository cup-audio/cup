import { expect, test } from "vitest";

import { createWorkerSentryOptions } from "#src/worker-sentry-options.ts";

const VERSION_METADATA = { id: "2f1d0c4e-7a54-4f0a-9d1c-3b2a1e0f9c8d", tag: "", timestamp: "" };
const DSN = "https://public@o1.ingest.de.sentry.io/1";

test("local development without a DSN turns Sentry off", () => {
  const options = createWorkerSentryOptions(
    { LOCAL_DEVELOPMENT: "true", SENTRY_DSN: "", CF_VERSION_METADATA: VERSION_METADATA },
    "fetch",
  );

  expect(options.enabled).toBe(false);
  expect(options.dsn).toBeUndefined();
});

test("local development with a DSN throws instead of sending", () => {
  expect(() =>
    createWorkerSentryOptions(
      { LOCAL_DEVELOPMENT: "true", SENTRY_DSN: DSN, CF_VERSION_METADATA: VERSION_METADATA },
      "fetch",
    ),
  ).toThrow(
    'SENTRY_DSN must be empty when LOCAL_DEVELOPMENT is "true": local development never sends to Sentry.',
  );
});

test("production with a DSN turns Sentry on for that DSN, the deployed version and the entry point", () => {
  const options = createWorkerSentryOptions(
    { LOCAL_DEVELOPMENT: "false", SENTRY_DSN: DSN, CF_VERSION_METADATA: VERSION_METADATA },
    "registry-durable-object",
  );

  expect(options.enabled).not.toBe(false);
  expect(options).toMatchObject({
    dsn: DSN,
    release: VERSION_METADATA.id,
    environment: "production",
    initialScope: { tags: { "cup.component": "registry-durable-object" } },
  });
});

test("production without a DSN throws instead of staying quiet", () => {
  expect(() =>
    createWorkerSentryOptions(
      { LOCAL_DEVELOPMENT: "false", SENTRY_DSN: "", CF_VERSION_METADATA: VERSION_METADATA },
      "fetch",
    ),
  ).toThrow(
    'SENTRY_DSN must be set when LOCAL_DEVELOPMENT is not "true": production always reports to Sentry.',
  );
});

test("production keeps Sentry's default integrations except Dedupe, and adds extra error data and Cup's capture marks", () => {
  const options = createWorkerSentryOptions(
    { LOCAL_DEVELOPMENT: "false", SENTRY_DSN: DSN, CF_VERSION_METADATA: VERSION_METADATA },
    "prepare-audiobook-workflow",
  );

  expect(typeof options.integrations).toBe("function");
  const integrations =
    typeof options.integrations === "function"
      ? options.integrations([{ name: "Dedupe" }, { name: "LinkedErrors" }])
      : [];
  expect(integrations.map((integration) => integration.name)).toEqual([
    "LinkedErrors",
    "ExtraErrorData",
    "CupForgetWrapperCaptures",
  ]);
});

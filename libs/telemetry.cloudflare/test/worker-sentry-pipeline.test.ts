/*
 * Runs the Worker options through Sentry's own Cloudflare SDK against the Sentry stub, so the
 * linked-errors and extra-error-data integrations build the event that `beforeSend` scrubs. No
 * request path of the Worker wraps a foreign error today, so the Worker integration tests cannot
 * provoke this case.
 */

import * as Sentry from "@sentry/cloudflare";
import { expect, test } from "vitest";

import { useSentryStub } from "@cup/sentry-stub";

import { createWorkerSentryOptions } from "#src/worker-sentry-options.ts";

/** Drizzle's query error: it embeds the SQL parameters and does not set `name`. */
class DrizzleQueryError extends Error {
  readonly params: unknown[];
  constructor(query: string, params: unknown[], cause: unknown) {
    super(`Failed query: ${query}\nparams: ${params.join(",")}`, { cause });
    this.params = params;
  }
}

test("a wrapped foreign error arrives with its linked exception's type but without its message", async ({
  onTestFinished,
}) => {
  const sentry = await useSentryStub({ onTestFinished });
  const env = {
    LOCAL_DEVELOPMENT: "false",
    SENTRY_DSN: sentry.dsn("cup-worker"),
    CF_VERSION_METADATA: { id: "test-version" },
  };
  const handler = Sentry.withSentry(
    (workerEnv: typeof env) => createWorkerSentryOptions(workerEnv, "fetch"),
    {
      fetch: (_request: Request, _env: typeof env, _context: unknown): never => {
        const drizzleError = new DrizzleQueryError(
          "select * from grants where label = ?",
          ["secret-label"],
          undefined,
        );
        throw new Error("The grant could not be loaded.", { cause: drizzleError });
      },
    },
  );
  const pending: Promise<unknown>[] = [];
  const context = {
    waitUntil: (promise: Promise<unknown>) => pending.push(promise),
    passThroughOnException: () => {},
    props: {},
  };

  await expect(
    handler.fetch?.(new Request("https://cup.audio/api/x"), env, context),
  ).rejects.toThrow("The grant could not be loaded.");
  await Promise.all(pending);

  await sentry.waitFor("an error event", () => sentry.errorEvents("cup-worker").length > 0);
  const [event] = sentry.errorEvents("cup-worker");
  expect(event?.exception?.values?.map(({ type, value }) => ({ type, value }))).toEqual([
    { type: "DrizzleQueryError", value: undefined },
    { type: "Error", value: "The grant could not be loaded." },
  ]);
  expect(JSON.stringify(event)).not.toContain("secret-label");
});

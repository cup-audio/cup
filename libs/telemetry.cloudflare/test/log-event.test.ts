/*
 * Runs the typed log-event helper through Sentry's own Cloudflare SDK, with the Worker options,
 * against the Sentry stub: what the operator sees for a warning that carries a wrapped error.
 */

import * as Sentry from "@sentry/cloudflare";
import { expect, test } from "vitest";

import { CupError } from "@cup/errors";
import { useSentryStub } from "@cup/sentry-stub";
import { TELEMETRY_ATTRIBUTES } from "@cup/telemetry.core";

import { logEvent } from "#src/log-event.ts";
import { createWorkerSentryOptions } from "#src/worker-sentry-options.ts";

/** Drizzle's query error: it embeds the SQL parameters and does not set `name`. */
class DrizzleQueryError extends Error {
  constructor(query: string, params: unknown[], cause: unknown) {
    super(`Failed query: ${query}\nparams: ${params.join(",")}`, { cause });
  }
}

class SqliteError extends Error {
  override name = "SqliteError";
}

test("a warning log arrives with its event name, root cause and exception chain", async ({
  onTestFinished,
}) => {
  const sentry = await useSentryStub({ onTestFinished });
  const env = {
    LOCAL_DEVELOPMENT: "false",
    SENTRY_DSN: sentry.dsn("cup-worker"),
    CF_VERSION_METADATA: { id: "test-version" },
  };
  const handler = Sentry.withSentry(
    (workerEnv: typeof env) => createWorkerSentryOptions(workerEnv, "account-durable-object"),
    {
      fetch: (_request: Request, _env: typeof env, _context: unknown) => {
        const error = new CupError("The conversion's artifacts could not be deleted.", {
          cause: new DrizzleQueryError(
            "delete from conversions where label = ?",
            ["secret-label"],
            new SqliteError("SQLITE_BUSY: secret-label"),
          ),
        });
        logEvent(
          "conversion-deletion-cleanup-failed",
          "A pass of the conversion's deletion cleanup failed; the next alarm retries it.",
          { attributes: { [TELEMETRY_ATTRIBUTES.CONVERSION_ID]: "c1" }, error },
        );
        return new Response(null, { status: 204 });
      },
    },
  );
  const pending: Promise<unknown>[] = [];
  const context = {
    waitUntil: (promise: Promise<unknown>) => pending.push(promise),
    passThroughOnException: () => {},
    props: {},
  };

  // The wrapper returns a promise at runtime, although its type follows the synchronous handler.
  await Promise.resolve(handler.fetch?.(new Request("https://cup.audio/api/x"), env, context));
  // Sentry flushes through `waitUntil`, after the handler returned.
  await Promise.all(pending);

  await sentry.waitFor("a log record", () => sentry.logs("cup-worker").length > 0);
  const [log] = sentry.logs("cup-worker");
  expect(log?.level).toBe("warn");
  expect(log?.body).toBe(
    "A pass of the conversion's deletion cleanup failed; the next alarm retries it.",
  );
  expect(log?.attributes).toMatchObject({
    "event.name": { value: "conversion-deletion-cleanup-failed", type: "string" },
    "cup.conversion.id": { value: "c1", type: "string" },
    "exception.type": { value: "SqliteError", type: "string" },
    "cup.exception.chain": { value: ["CupError", "DrizzleQueryError"], type: "array" },
  });
  expect(log?.attributes["exception.message"]).toBeUndefined();
  expect(log?.attributes["exception.stacktrace"]?.value).toMatch(/^SqliteError\n\s+at /);
  expect(JSON.stringify(sentry.envelopes)).not.toContain("secret-label");
});

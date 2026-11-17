import type { ErrorEvent, Exception } from "@sentry/core";
import { expect, test } from "vitest";

import { CupError } from "@cup/errors";

import { beforeSendServerEvent, beforeSendServerSpan } from "#src/server-before-send.ts";

class DrizzleQueryError extends Error {
  readonly params: unknown[];
  constructor(query: string, params: unknown[], cause: unknown) {
    super(`Failed query: ${query}\nparams: ${params.join(",")}`, { cause });
    this.params = params;
  }
}

class SqliteError extends Error {
  override name = "SqliteError";
}

/** The exception values Sentry's linked-errors integration builds: innermost first, main last. */
function exceptionValuesOf(error: Error): Exception[] {
  const chain: Error[] = [];
  for (let current: unknown = error; current instanceof Error; current = current.cause) {
    chain.push(current);
  }
  return chain
    .map((entry, depth) => ({
      type: entry.name,
      value: entry.message,
      mechanism: { type: depth === 0 ? "generic" : "chained", exception_id: depth },
    }))
    .toReversed();
}

test("drops the IP address and IP headers and masks URLs", () => {
  const event: ErrorEvent = {
    type: undefined,
    user: { id: "a1", ip_address: "203.0.113.7" },
    request: {
      url: "https://cup.audio/api/files/audiobooks/c1/cover-image?token=v1.a.b",
      query_string: "token=v1.a.b&size=2",
      headers: {
        "CF-Connecting-IP": "203.0.113.7",
        "x-forwarded-for": "203.0.113.7",
        "X-Real-IP": "203.0.113.7",
        "True-Client-IP": "203.0.113.7",
        "CF-Connecting-IPv6": "2001:db8::7",
        "X-Vercel-Forwarded-For": "203.0.113.7",
        Accept: "*/*",
      },
    },
    breadcrumbs: [
      { category: "fetch", data: { url: "https://cup.audio/app/?code=abc", status_code: 200 } },
    ],
  };

  expect(beforeSendServerEvent(event, {})).toEqual({
    type: undefined,
    user: { id: "a1", ip_address: null },
    request: {
      url: "https://cup.audio/api/files/audiobooks/c1/cover-image?token=[Filtered]",
      query_string: "token=[Filtered]&size=2",
      headers: { Accept: "*/*" },
    },
    breadcrumbs: [
      {
        category: "fetch",
        data: { url: "https://cup.audio/app/?code=[Filtered]", status_code: 200 },
      },
    ],
  });
});

test("drops the time zone, a location finer than the country, from events and spans", () => {
  const event: ErrorEvent = {
    type: undefined,
    contexts: {
      culture: { timezone: "Europe/Vienna" },
      cloud_resource: { "cloud.provider": "cloudflare" },
    },
  };
  const span = {
    name: "GET",
    attributes: {
      "culture.timezone": { value: "Europe/Vienna", type: "string" },
      "url.path": "/x",
    },
  };

  expect(beforeSendServerEvent(event, {})?.contexts).toEqual({
    cloud_resource: { "cloud.provider": "cloudflare" },
  });
  expect(beforeSendServerSpan(span)).toEqual({ name: "GET", attributes: { "url.path": "/x" } });
});

test("keeps the messages of Cup's own errors and drops those of foreign errors in the chain", () => {
  const sqliteError = new SqliteError("SQLITE_CONSTRAINT: value 'secret' too long");
  const drizzleError = new DrizzleQueryError(
    "insert into grants values (?)",
    ["secret"],
    sqliteError,
  );
  const error = new CupError("The grant could not be stored.", { cause: drizzleError });
  const event: ErrorEvent = {
    type: undefined,
    exception: { values: exceptionValuesOf(error) },
    contexts: {
      Error: { cause: { Error: { params: ["secret"] } } },
    },
  };

  const sent = beforeSendServerEvent(event, { originalException: error });

  expect(sent?.exception?.values).toEqual([
    { type: "SqliteError", mechanism: { type: "chained", exception_id: 2 } },
    { type: "DrizzleQueryError", mechanism: { type: "chained", exception_id: 1 } },
    {
      type: "Error",
      value: "The grant could not be stored.",
      mechanism: { type: "generic", exception_id: 0 },
    },
  ]);
  // extraErrorDataIntegration copies the cause's own properties, here the SQL parameters; with
  // the cause dropped, nothing of the error's own data is left.
  expect(sent?.contexts).toEqual({});
});

test("drops the message and the extra data of a foreign error captured unwrapped", () => {
  const error = new DrizzleQueryError("select ?", ["secret"], undefined);
  const event: ErrorEvent = {
    type: undefined,
    exception: { values: exceptionValuesOf(error) },
    contexts: { Error: { params: ["secret"] } },
  };

  const sent = beforeSendServerEvent(event, { originalException: error });

  expect(sent?.exception?.values).toEqual([
    { type: "DrizzleQueryError", mechanism: { type: "generic", exception_id: 0 } },
  ]);
  expect(sent?.contexts).toEqual({});
});

test("masks URLs in the messages of Cup's own errors", () => {
  const error = new CupError("Could not read https://cup.audio/x?token=secret");
  const event: ErrorEvent = { type: undefined, exception: { values: exceptionValuesOf(error) } };

  expect(beforeSendServerEvent(event, { originalException: error })?.exception?.values).toEqual([
    {
      type: "Error",
      value: "Could not read https://cup.audio/x?token=[Filtered]",
      mechanism: { type: "generic", exception_id: 0 },
    },
  ]);
});

test.each(["auto.faas.cloudflare.workflow", "auto.faas.cloudflare.durable_object"])(
  "drops the capture a wrapper made itself (%s), which Cup's capture rule leaves to Cup",
  (mechanism) => {
    const error = new CupError("Conversion grant is not initialized");
    const event: ErrorEvent = {
      type: undefined,
      exception: {
        values: [{ type: "Error", value: error.message, mechanism: { type: mechanism } }],
      },
    };

    expect(beforeSendServerEvent(event, { originalException: error })).toBeNull();
  },
);

test("keeps an event Cup captured itself", () => {
  const error = new CupError("Preparation failed");
  const event: ErrorEvent = {
    type: undefined,
    exception: {
      values: [{ type: "Error", value: error.message, mechanism: { type: "generic" } }],
    },
  };

  expect(beforeSendServerEvent(event, { originalException: error })).toMatchObject({
    exception: { values: [{ value: "Preparation failed" }] },
  });
});

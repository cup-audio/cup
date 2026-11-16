import { expect, test } from "vitest";

import { describeExceptionChain } from "#src/exception-chain.ts";

/** Drizzle's query error: it embeds the SQL parameters and does not set `name`. */
class DrizzleQueryError extends Error {
  constructor(query: string, params: unknown[], cause: unknown) {
    super(`Failed query: ${query}\nparams: ${params.join(",")}`, { cause });
  }
}

class SqliteError extends Error {
  override name = "SqliteError";
}

class ContentLimitError extends Error {
  override name = "ContentLimitError";
}

test("describes the root cause and the wrapper types from outermost to innermost", () => {
  const rootCause = new Error("Registry unavailable");
  const error = new Error("Deletion pass failed", {
    cause: new TypeError("Wrapped", { cause: rootCause }),
  });

  expect(describeExceptionChain(error)).toEqual({
    rootCause: {
      type: "Error",
      message: "Registry unavailable",
      stacktrace: rootCause.stack,
    },
    wrapperTypes: ["Error", "TypeError"],
  });
});

test("keeps the messages of Cup's own error classes only", () => {
  const rootCause = new SqliteError("UNIQUE constraint failed: grants.label = secret-label");
  const error = new ContentLimitError("Narration exceeds the ceiling", {
    cause: new DrizzleQueryError(
      "select * from grants where label = ?",
      ["secret-label"],
      rootCause,
    ),
  });

  const chain = describeExceptionChain(error);

  expect(chain.rootCause.type).toBe("SqliteError");
  expect(chain.rootCause.message).toBeUndefined();
  expect(chain.wrapperTypes).toEqual(["ContentLimitError", "DrizzleQueryError"]);
  expect(JSON.stringify(chain)).not.toContain("secret-label");
});

test("keeps a foreign root cause's stack frames but not the message in its first line", () => {
  const rootCause = new SqliteError("UNIQUE constraint failed: secret-label");

  const { rootCause: described } = describeExceptionChain(rootCause);

  expect(described.stacktrace?.split("\n")[0]).toBe("SqliteError");
  expect(described.stacktrace?.split("\n")[1]).toMatch(/^\s+at /);
  expect(described.stacktrace).not.toContain("secret-label");
});

test("describes an error without a cause as its own root cause", () => {
  const error = new Error("Registry unavailable");

  expect(describeExceptionChain(error)).toEqual({
    rootCause: { type: "Error", message: "Registry unavailable", stacktrace: error.stack },
    wrapperTypes: [],
  });
});

test("describes a thrown value that is not an error by its type, without the value", () => {
  expect(describeExceptionChain(new Error("Request failed", { cause: "socket hang up" }))).toEqual({
    rootCause: { type: "string" },
    wrapperTypes: ["Error"],
  });
  expect(describeExceptionChain(42)).toEqual({ rootCause: { type: "number" }, wrapperTypes: [] });
});

test("stops at the last error before a cause cycle repeats", () => {
  const outer = new Error("Outer");
  const inner = new Error("Inner", { cause: outer });
  outer.cause = inner;

  expect(describeExceptionChain(outer)).toMatchObject({
    rootCause: { type: "Error", message: "Inner" },
    wrapperTypes: ["Error"],
  });
});

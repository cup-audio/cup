import { expect, test } from "vitest";

import { CupError } from "#src/cup-error.ts";
import { describeExceptionChain, isCupError } from "#src/exception-chain.ts";

class DrizzleQueryError extends Error {
  constructor(query: string, params: unknown[], cause: unknown) {
    super(`Failed query: ${query}\nparams: ${params.join(",")}`, { cause });
  }
}

class SqliteError extends Error {
  override name = "SqliteError";
}

class ContentLimitError extends CupError {
  override name = "ContentLimitError";
}

test("describes the root cause and the wrapper types from outermost to innermost", () => {
  const rootCause = new CupError("Registry unavailable");
  const error = new CupError("Deletion pass failed", {
    cause: new TypeError("Wrapped", { cause: rootCause }),
  });

  expect(describeExceptionChain(error)).toEqual({
    rootCause: {
      type: "CupError",
      message: "Registry unavailable",
      stacktrace: rootCause.stack,
    },
    wrapperTypes: ["CupError", "TypeError"],
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

test("drops the message of a plain `Error`, which a dependency can throw with any data in it", () => {
  const error = new Error("Failed query: select * from grants where label = secret-label");

  const chain = describeExceptionChain(error);

  expect(chain.rootCause).toEqual({ type: "Error", stacktrace: expect.any(String) });
  expect(JSON.stringify(chain)).not.toContain("secret-label");
});

test("counts an error rebuilt from a Cup error by a Durable Object RPC call as Cup's own", () => {
  const thrown = new CupError("Account execution is fenced");
  const rebuilt = Object.assign(
    new Error(thrown.message),
    Object.fromEntries(Object.entries(thrown)),
    {
      remote: true,
    },
  );

  expect(isCupError(rebuilt)).toBe(true);
  expect(isCupError(Object.assign(new Error("Failed query"), { remote: true }))).toBe(false);
});

test("describes an error without a cause as its own root cause", () => {
  const error = new CupError("Registry unavailable");

  expect(describeExceptionChain(error)).toEqual({
    rootCause: { type: "CupError", message: "Registry unavailable", stacktrace: error.stack },
    wrapperTypes: [],
  });
});

test("describes a thrown value that is not an error by its type, without the value", () => {
  expect(
    describeExceptionChain(new CupError("Request failed", { cause: "socket hang up" })),
  ).toEqual({
    rootCause: { type: "string" },
    wrapperTypes: ["CupError"],
  });
  expect(describeExceptionChain(42)).toEqual({ rootCause: { type: "number" }, wrapperTypes: [] });
});

test("stops at the last error before a cause cycle repeats", () => {
  const outer = new CupError("Outer");
  const inner = new CupError("Inner", { cause: outer });
  outer.cause = inner;

  expect(describeExceptionChain(outer)).toMatchObject({
    rootCause: { type: "CupError", message: "Inner" },
    wrapperTypes: ["CupError"],
  });
});

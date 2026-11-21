import { expect, test } from "vitest";

import { isOnAccountAllowlist } from "#src/use-cases/account-allowlist.ts";

test("an email on the list is on it, whatever its case and the spacing around entries", () => {
  expect(
    isOnAccountAllowlist("Reader@Example.test", " a@example.test , reader@example.test "),
  ).toBe(true);
});

test("an email matches only an exact entry", () => {
  expect(isOnAccountAllowlist("re.ader@example.test", "reader@example.test")).toBe(false);
  expect(isOnAccountAllowlist("reader+1@example.test", "reader@example.test")).toBe(false);
  expect(isOnAccountAllowlist("reader@example.test.evil", "reader@example.test")).toBe(false);
});

test("an empty or missing list, and an identity without an email, admit nobody", () => {
  expect(isOnAccountAllowlist("reader@example.test", "")).toBe(false);
  expect(isOnAccountAllowlist("reader@example.test", " , ")).toBe(false);
  expect(isOnAccountAllowlist(undefined, "reader@example.test")).toBe(false);
  expect(isOnAccountAllowlist("reader@example.test", undefined)).toBe(false);
});

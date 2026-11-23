import { expect, test } from "vitest";

import { assertUnreachable } from "#src/assert-unreachable.ts";

test("throws with the JSON of a value outside the union", () => {
  expect(() => {
    Reflect.apply(assertUnreachable, undefined, [{ kind: "unknown" }]);
  }).toThrow('Unexpected value: {"kind":"unknown"}');
});

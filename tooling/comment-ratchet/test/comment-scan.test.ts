import { expect, test } from "vitest";

import { fingerprintComment, scanComments } from "#src/comment-scan.ts";

test("finds line, block and JSX comments in TypeScript, but not comment-like strings, regexes or JSX text", () => {
  const source = [
    "const ratio = total / count; // trailing",
    "const pattern = /\\/\\/ not a comment/;",
    "const url = `https://cup.audio/${'//'}`;",
    "/** Documented. */",
    "export function View() {",
    "  return <p>// visible text{/* in JSX */}</p>;",
    "}",
  ].join("\n");

  expect(scanComments("view.tsx", source)).toEqual([
    { line: 1, value: " trailing" },
    { line: 4, value: "* Documented. " },
    { line: 6, value: " in JSX " },
  ]);
});

test("leaves out comments a tool reads", () => {
  const source = [
    "// @ts-check",
    "// oxlint-disable-next-line no-console",
    "/** @type {import('oxlint').DummyRule} */",
    "// @ts-expect-error -- the fixture is malformed on purpose",
    "export const value = 1;",
  ].join("\n");

  expect(scanComments("config.js", source)).toEqual([]);
});

test("finds comments in hash-, SQL- and markup-commented files and keeps the statement breakpoint", () => {
  expect(scanComments("main.tf", 'name = "a#b" # why\n# own line\n')).toEqual([
    { line: 1, value: " why" },
    { line: 2, value: " own line" },
  ]);
  expect(scanComments("0001.sql", "-- reason\nSELECT 1;\n--> statement-breakpoint\n")).toEqual([
    { line: 1, value: " reason" },
  ]);
  expect(scanComments("strings.xml", "<a><!-- label --></a>")).toEqual([
    { line: 1, value: " label " },
  ]);
  expect(scanComments("Main.java", 'String s = "// no"; // yes\n')).toEqual([
    { line: 1, value: " yes" },
  ]);
});

test("fingerprints a comment by its words, so reflowing or re-indenting it keeps the fingerprint", () => {
  expect(fingerprintComment("*\n   * One reason,\n   * reflowed.\n   ")).toBe(
    fingerprintComment("* One reason, reflowed. "),
  );
  expect(fingerprintComment(" One reason")).not.toBe(fingerprintComment(" Another reason"));
});

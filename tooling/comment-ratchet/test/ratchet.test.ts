import { expect, test } from "vitest";

import { countFingerprints, pruneBaseline } from "#src/baseline.ts";
import type { ScannedComment } from "#src/comment-scan.ts";
import { checkRatchet } from "#src/ratchet.ts";

const KEPT: ScannedComment = { line: 3, value: " kept for now" };
const DELETED: ScannedComment = { line: 9, value: " deleted later" };
const BASELINE = { "src/a.ts": countFingerprints([KEPT, DELETED]) };

test("allows a baseline comment on any line, and reports one it lacks as new", () => {
  const report = checkRatchet(
    BASELINE,
    new Map([
      ["src/a.ts", [{ ...KEPT, line: 40 }, DELETED]],
      ["src/b.ts", [{ line: 2, value: " brand new" }]],
    ]),
  );

  expect(report.newComments).toEqual([{ file: "src/b.ts", line: 2, text: "brand new" }]);
  expect(report.deletedBaselineComments).toBe(0);
});

test("reports a copy of a baseline comment beyond its count as new", () => {
  const report = checkRatchet(
    BASELINE,
    new Map([["src/a.ts", [KEPT, DELETED, { ...KEPT, line: 12 }]]]),
  );

  expect(report.newComments).toEqual([{ file: "src/a.ts", line: 12, text: "kept for now" }]);
});

test("counts deleted baseline comments, which pruning drops without ever adding any", () => {
  const commentsByFile = new Map([
    ["src/a.ts", [KEPT]],
    ["src/b.ts", [{ line: 1, value: " not in the baseline" }]],
  ]);

  expect(checkRatchet(BASELINE, commentsByFile).deletedBaselineComments).toBe(1);
  expect(pruneBaseline(BASELINE, commentsByFile)).toEqual({
    "src/a.ts": countFingerprints([KEPT]),
  });
  expect(pruneBaseline(BASELINE, new Map())).toEqual({});
});

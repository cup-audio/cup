import fs from "node:fs";
import { z } from "zod";

import { fingerprintComment, type ScannedComment } from "#src/comment-scan.ts";

export type Baseline = Record<string, Record<string, number>>;

const BASELINE_SCHEMA = z.record(z.string(), z.record(z.string(), z.number().int().positive()));

export const BASELINE_FILE = new URL("../comment-baseline.json", import.meta.url);

export async function readBaseline(file: URL = BASELINE_FILE): Promise<Baseline> {
  return BASELINE_SCHEMA.parse(JSON.parse(await fs.promises.readFile(file, "utf8")));
}

export function readBaselineSync(file: URL = BASELINE_FILE): Baseline {
  return BASELINE_SCHEMA.parse(JSON.parse(fs.readFileSync(file, "utf8")));
}

export async function writeBaseline(baseline: Baseline, file: URL = BASELINE_FILE): Promise<void> {
  await fs.promises.writeFile(file, `${JSON.stringify(sortBaseline(baseline), null, 2)}\n`);
}

export function countFingerprints(comments: ScannedComment[]): Record<string, number> {
  const counts: Record<string, number> = {};
  for (const comment of comments) {
    const fingerprint = fingerprintComment(comment.value);
    counts[fingerprint] = (counts[fingerprint] ?? 0) + 1;
  }
  return counts;
}

export function findCommentsBeyondBaseline<Comment extends ScannedComment>(
  comments: Comment[],
  allowed: Record<string, number> = {},
): Comment[] {
  const remaining = { ...allowed };
  return comments.filter((comment) => {
    const fingerprint = fingerprintComment(comment.value);
    const left = remaining[fingerprint] ?? 0;
    remaining[fingerprint] = left - 1;
    return left <= 0;
  });
}

export function countDeletedBaselineComments(
  comments: ScannedComment[],
  allowed: Record<string, number> = {},
): number {
  const actual = countFingerprints(comments);
  return Object.entries(allowed).reduce(
    (deleted, [fingerprint, count]) => deleted + Math.max(0, count - (actual[fingerprint] ?? 0)),
    0,
  );
}

export function pruneBaseline(
  baseline: Baseline,
  commentsByFile: ReadonlyMap<string, ScannedComment[]>,
): Baseline {
  const pruned: Baseline = {};
  for (const [file, allowed] of Object.entries(baseline)) {
    const actual = countFingerprints(commentsByFile.get(file) ?? []);
    const kept = Object.fromEntries(
      Object.entries(allowed)
        .map(
          ([fingerprint, count]) =>
            [fingerprint, Math.min(count, actual[fingerprint] ?? 0)] as const,
        )
        .filter(([, count]) => count > 0),
    );
    if (Object.keys(kept).length > 0) {
      pruned[file] = kept;
    }
  }
  return pruned;
}

function sortBaseline(baseline: Baseline): Baseline {
  return Object.fromEntries(
    Object.keys(baseline)
      .toSorted(compareText)
      .map((file) => [
        file,
        Object.fromEntries(
          Object.entries(baseline[file] ?? {}).toSorted(([first], [second]) =>
            compareText(first, second),
          ),
        ),
      ]),
  );
}

function compareText(first: string, second: string): number {
  return first < second ? -1 : first > second ? 1 : 0;
}

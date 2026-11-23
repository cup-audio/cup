import {
  countDeletedBaselineComments,
  findCommentsBeyondBaseline,
  type Baseline,
} from "#src/baseline.ts";
import {
  countCommentLines,
  normalizeCommentValue,
  type ScannedComment,
} from "#src/comment-scan.ts";

export type RatchetReport = {
  newComments: { file: string; line: number; text: string }[];
  deletedBaselineComments: number;
  remainingComments: number;
  remainingCommentLines: number;
};

export function checkRatchet(
  baseline: Baseline,
  commentsByFile: ReadonlyMap<string, ScannedComment[]>,
): RatchetReport {
  const files = new Set([...Object.keys(baseline), ...commentsByFile.keys()]);
  const report: RatchetReport = {
    newComments: [],
    deletedBaselineComments: 0,
    remainingComments: 0,
    remainingCommentLines: 0,
  };
  for (const file of [...files].toSorted()) {
    const comments = commentsByFile.get(file) ?? [];
    report.remainingComments += comments.length;
    report.remainingCommentLines += comments.reduce(
      (lines, comment) => lines + countCommentLines(comment),
      0,
    );
    report.deletedBaselineComments += countDeletedBaselineComments(comments, baseline[file]);
    for (const comment of findCommentsBeyondBaseline(comments, baseline[file])) {
      report.newComments.push({
        file,
        line: comment.line,
        text: normalizeCommentValue(comment.value).slice(0, 100),
      });
    }
  }
  return report;
}

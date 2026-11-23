import path from "node:path";
import url from "node:url";

import { findCommentsBeyondBaseline, readBaselineSync, type Baseline } from "#src/baseline.ts";
import { isFunctionalComment } from "#src/comment-scan.ts";

type LintComment = {
  type: "Line" | "Block" | "Shebang";
  value: string;
  start: number;
  end: number;
};

type LintLocation = { line: number; column: number };

type LintContext = {
  physicalFilename: string;
  sourceCode: {
    getAllComments: () => LintComment[];
    getLocFromIndex: (index: number) => LintLocation;
  };
  report: (descriptor: {
    loc: { start: LintLocation; end: LintLocation };
    message: string;
  }) => void;
};

const REPOSITORY_ROOT = url.fileURLToPath(new URL("../../..", import.meta.url));
const MESSAGE =
  "Code comments are banned (ADR 0037). Say it in code, move a decision into an ADR, or file an issue for the hack; `/delete-comment` walks through it.";

let cachedBaseline: Baseline | undefined;

function loadBaseline(): Baseline {
  cachedBaseline ??= readBaselineSync();
  return cachedBaseline;
}

const noComments = {
  meta: {
    type: "suggestion" as const,
    docs: { description: "Ban code comments beyond the ratchet baseline" },
  },
  create(context: LintContext) {
    return {
      Program() {
        const file = path
          .relative(REPOSITORY_ROOT, context.physicalFilename)
          .split(path.sep)
          .join("/");
        const lintComments = context.sourceCode
          .getAllComments()
          .filter((comment) => comment.type !== "Shebang" && !isFunctionalComment(comment.value));
        const scanned = lintComments.map((comment) => ({
          line: context.sourceCode.getLocFromIndex(comment.start).line,
          value: comment.value,
          source: comment,
        }));
        for (const { source } of findCommentsBeyondBaseline(scanned, loadBaseline()[file])) {
          context.report({
            loc: {
              start: context.sourceCode.getLocFromIndex(source.start),
              end: context.sourceCode.getLocFromIndex(source.end),
            },
            message: MESSAGE,
          });
        }
      },
    };
  },
};

export default {
  meta: { name: "cup-comments" },
  rules: { "no-comments": noComments },
};

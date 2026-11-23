#!/usr/bin/env node
import { Command, CommanderError } from "@commander-js/extra-typings";
import process from "node:process";

import { pruneBaseline, readBaseline, writeBaseline } from "#src/baseline.ts";
import {
  countCommentLines,
  normalizeCommentValue,
  type ScannedComment,
} from "#src/comment-scan.ts";
import { checkRatchet } from "#src/ratchet.ts";
import { scanRepository } from "#src/repository.ts";

const POLICY =
  "Code comments are banned (ADR 0037). Say it in code, move a decision into an ADR, or file an issue for the hack; `/delete-comment` walks through it.";

export async function runCli(args: string[]): Promise<number> {
  let exitCode = 0;
  const program = new Command()
    .name("comment-ratchet")
    .description("Ban new code comments and let the baseline of existing ones only shrink")
    .showHelpAfterError()
    .exitOverride();

  program
    .command("check")
    .description(
      "Fail on a comment the baseline lacks, or on a baseline that still lists deleted comments",
    )
    .action(async () => {
      const report = checkRatchet(await readBaseline(), await scanRepository());
      for (const comment of report.newComments) {
        console.error(`${comment.file}:${comment.line}: new comment: ${comment.text}`);
      }
      if (report.newComments.length > 0) {
        console.error(`\n${report.newComments.length} new comment(s). ${POLICY}`);
        exitCode = 1;
      }
      if (report.deletedBaselineComments > 0) {
        console.error(
          `The baseline still lists ${report.deletedBaselineComments} deleted comment(s); run \`pnpm comments:prune\` and commit the baseline.`,
        );
        exitCode = 1;
      }
      if (exitCode === 0) {
        console.log(
          `No new comments; ${report.remainingComments} baseline comment(s) left over ${report.remainingCommentLines} line(s).`,
        );
      }
    });

  program
    .command("prune")
    .description("Drop deleted comments from the baseline; never adds any")
    .action(async () => {
      const baseline = await readBaseline();
      await writeBaseline(pruneBaseline(baseline, await scanRepository()));
    });

  program
    .command("list")
    .description(
      "List the comments left under the given paths, or the files with the most comment lines",
    )
    .argument("[paths...]", "files or directories relative to the repository root")
    .option("--top <count>", "list this many files with the most comment lines instead")
    .action(async (paths, { top }) => {
      const commentsByFile = await scanRepository();
      if (top !== undefined) {
        for (const { file, lines } of rankFilesByCommentLines(commentsByFile).slice(
          0,
          Number(top),
        )) {
          console.log(`${lines}\t${file}`);
        }
        return;
      }
      for (const [file, comments] of commentsByFile) {
        if (paths.length > 0 && !paths.some((prefix) => isWithin(file, prefix))) {
          continue;
        }
        for (const comment of comments) {
          console.log(`${file}:${comment.line}: ${normalizeCommentValue(comment.value)}`);
        }
      }
    });

  program
    .command("stats")
    .description("Count the comments and comment lines left in the baseline")
    .action(async () => {
      const report = checkRatchet(await readBaseline(), await scanRepository());
      console.log(
        JSON.stringify({
          remainingComments: report.remainingComments,
          remainingCommentLines: report.remainingCommentLines,
        }),
      );
    });

  try {
    await program.parseAsync(args, { from: "user" });
    return exitCode;
  } catch (error) {
    if (error instanceof CommanderError) {
      return error.exitCode;
    }
    throw error;
  }
}

function rankFilesByCommentLines(
  commentsByFile: ReadonlyMap<string, ScannedComment[]>,
): { file: string; lines: number }[] {
  return [...commentsByFile]
    .map(([file, comments]) => ({
      file,
      lines: comments.reduce((total, comment) => total + countCommentLines(comment), 0),
    }))
    .toSorted((first, second) => second.lines - first.lines);
}

function isWithin(file: string, prefix: string): boolean {
  const normalized = prefix.replace(/\/+$/, "");
  return file === normalized || file.startsWith(`${normalized}/`);
}

if (import.meta.main) {
  process.exitCode = await runCli(process.argv.slice(2));
}

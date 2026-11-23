# Comment ratchet

Cup bans code comments ([ADR 0037](../../docs/adr/0037-ban-code-comments-and-ratchet-the-ones-left.md)). This package enforces the ban as a ratchet: [`comment-baseline.json`](comment-baseline.json) lists the comments that existed when the ban started and have not been deleted since, every other comment fails, and the baseline can only shrink. The [`/delete-comment`](../../.claude/skills/delete-comment/SKILL.md) skill shrinks it.

## Checks

- The oxlint rule `cup-comments/no-comments`, which every package's lint runs through [`@cup/config-oxlint`](../config-oxlint/oxlint-base.js), reports a comment in a JavaScript or TypeScript file that its file's baseline entry lacks, in the editor and in `turbo lint`.
- `pnpm comments:check`, a step of every [validation gate](../validation-gates/README.md), scans every tracked or untracked, unignored file of the languages the [scanner](src/comment-scan.ts) knows (TypeScript and JavaScript, Java, Swift, Gradle, C, CSS, JSON, shell, Terraform, YAML, TOML, SQL and XML), leaving out files marked `linguist-generated` in `.gitattributes`. It fails on a comment the baseline lacks and on a baseline that still lists a deleted comment, so every deletion shrinks the committed baseline.

A comment a tool reads is not a comment to the ratchet: lint, type-check and formatter directives, `--> statement-breakpoint` in migrations, and JSDoc types in `// @ts-check` JavaScript ([`FUNCTIONAL_COMMENT`](src/comment-scan.ts)).

## Baseline

The baseline maps each file to its comments' fingerprints and how often each occurs. A fingerprint hashes a comment's words, so moving, re-indenting or reflowing a comment keeps it allowed; editing its words makes it a new comment. A copy of an allowed comment beyond its count is new too.

| Command                      | Does                                                                              |
| ---------------------------- | --------------------------------------------------------------------------------- |
| `pnpm comments:check`        | The ratchet check above                                                           |
| `pnpm comments:prune`        | Drops deleted comments from the baseline; it never adds one                       |
| `pnpm comments:list <paths>` | Lists the comments left under the paths; `--top <n>` ranks files by comment lines |
| `pnpm comments:stats`        | Counts the comments and comment lines left                                        |

Nothing adds to the baseline. Renaming or moving a file turns its comments into new ones: delete them in the same change, or carry the file's baseline entry over to its new path by hand.

## Validation

Run `pnpm --filter @cup/comment-ratchet test` and `lint`. The tests cover the scanner across languages, including comment-like strings, regular expressions and JSX text, the ratchet's counting, pruning, and the oxlint rule through oxlint's `RuleTester`.

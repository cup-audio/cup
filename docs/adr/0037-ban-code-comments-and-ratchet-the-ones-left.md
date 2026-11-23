---
status: accepted
---

# Ban code comments and ratchet the ones left

Until 2026-11-23 Cup's code carried about 3,300 comments over about 6,700 lines. An audit on that date, at the operator's request, sorted every one into four kinds: tautologies that repeat what the code shows, stale comments that describe code or decisions that no longer hold, excuses that let a hacky implementation stand and then get copied along with it, and decision records that hold an important, non-obvious decision. Comments are free to write and nothing checks them against the code, so they kept growing, drifted from the code, and gave agents a way to explain a hack instead of fixing it.

## Decision

Cup's code has no comments. Each kind's knowledge has one home instead:

- A tautology or a stale comment is deleted.
- An excuse is deleted, and the hack it excused becomes a Linear issue to fix.
- A decision record moves into an ADR, one per decision, and the comment is deleted.

Comments a tool reads (lint, type-check and formatter directives, migration statement breakpoints, JSDoc types in `// @ts-check` JavaScript) are not documentation and stay.

The [comment ratchet](../../tooling/comment-ratchet/README.md) enforces the ban: an oxlint rule reports a comment in JavaScript and TypeScript, and `pnpm comments:check`, a step of every validation gate, checks every language the repository holds. Both allow the comments of a committed baseline, which only shrinks, so the comments the audit could not resolve in its first change stay allowed until the [`/delete-comment`](../../.claude/skills/delete-comment/SKILL.md) skill resolves them.

## Considered options

- Enforcing the ban only on new code, without a baseline that shrinks. Rejected: the existing comments would stay forever, and an edit next to one would invite copying it.
- Deleting every comment in one change without the ratchet. Rejected: moving decision records into ADRs and filing issues needs care per comment, and one change cannot do it for all of them well.
- Per-file comment counts as the baseline. Rejected: a file could swap a deleted comment for a new one at the same count; the baseline fingerprints each comment's words instead.

## Consequences

- Names, types, tests and the structure of the code carry what comments used to explain; a reason the code cannot show goes into an ADR, a package `README.md`, or an architecture page.
- The wiki schema's rule that identifiers and test mechanics belong in code no longer offers code comments as their home.
- Editing the words of an allowed comment makes it a new comment, so a touched comment is deleted rather than updated.
- `.patricktree-stack` is a separate repository and keeps its own conventions; the ratchet does not scan it.

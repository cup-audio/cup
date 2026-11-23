---
name: delete-comment
description: Audit the code comments the comment ratchet still allows, delete them, and move what they knew into ADRs and Linear issues.
disable-model-invocation: true
argument-hint: "[paths or packages; default: the files with the most baseline comment lines]"
---

# Delete comments

Code comments are banned ([ADR 0037](../../../docs/adr/0037-ban-code-comments-and-ratchet-the-ones-left.md)); the [comment ratchet](../../../tooling/comment-ratchet/README.md) allows only the comments in its baseline, and the baseline only shrinks. Each run of this skill shrinks it further: every comment in scope is categorized, deleted, and its knowledge lands where it belongs.

## Steps

1. **Scope.** Use the paths or packages in the arguments. Without arguments, run `pnpm comments:list --top 20` and take those files. Done when you hold the list of in-scope comments from `pnpm comments:list <paths>`.
2. **Categorize** every in-scope comment by the categories below, reading it with the code around it. For more than about 300 comments, fan out to subagents, one per package, each given this file's path and its package; you keep steps 4 to 6. Done when every listed comment has exactly one category.
3. **Delete.** Remove every comment except `keep`. Remove the lines a comment occupied when nothing else was on them; keep the code of a line with a trailing comment; in JSX remove `{/* … */}` with its braces. Change no code. Done when `pnpm comments:list <paths>` prints only the `keep` comments.
4. **Record decisions.** Turn the decision records into ADRs by the [wiki schema](../../../docs/agents/domain.md#record-decisions-and-evidence): one ADR per decision, absorbing every comment about it, never one per comment; a decision an existing ADR already records needs none. Cite the commit and pull request that introduced each comment (`git blame HEAD -- <file>`), date the record, and add each ADR to the [ADR index](../../../docs/adr/README.md). Done when every decision record is in an ADR you can name.
5. **File the hacks.** Turn the excuses into Linear issues by the [issue tracker guide](../../../docs/agents/issue-tracker.md#linear): one issue per underlying hack, naming its files, quoting the excuse, and stating a fix with acceptance criteria. Check `list_issues` for an existing one first. Done when every excuse has an issue identifier.
6. **Ratchet.** Run `pnpm comments:prune`, then `pnpm comments:check`, `pnpm format`, `pnpm docs:check`, and the lint, typecheck and tests of every touched package. Done when all pass and the baseline diff only removes entries.

Report the counts per category, the comment lines deleted, the new ADRs, the new issues, and every `keep` with its reason.

## Categories

- **Tautology**: repeats what the code shows: a doc comment restating a name, type or signature, narration of the next lines, a label a reader derives instantly, a test comment restating the test's steps or name. Delete.
- **Stale**: describes code, names, behaviour, issues or decisions that no longer hold. Verify by grep or reading before choosing it. Delete.
- **Excuse**: lets a hack off the hook: a workaround kept for now, TODO, "temporary", "until X", a magic sleep or retry with a shrug, duplicated logic or a disabled check with a justification. The fix is changing the code. File an issue, then delete.
- **Decision record**: an important, non-obvious decision or constraint the code cannot show: why this approach over the obvious one, an external system's behaviour that forces the code's shape (browser, OS, provider, protocol), an invariant other components rely on, a security or privacy reason. Move into an ADR, then delete.
- **Keep**: deleting would lose something you cannot capture faithfully yet. Rare; say why. The ratchet tolerates it.

A comment that mixes kinds takes its most valuable kind: decision record, then excuse, then stale, then tautology.

Comments a tool reads (lint and type-check directives, `--> statement-breakpoint`, JSDoc types in `// @ts-check` JavaScript) are not comments to the ratchet; leave them.

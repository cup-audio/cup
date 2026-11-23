---
status: accepted
---

# Configure lint, format and Knip around their tools' limits

oxlint, oxfmt, markdownlint and Knip each have limits that shape the repository's configuration. These settings came with release 1.0.0 (the root oxlint config, Knip's root workspace), the shared `restrictImports` helper ([#54](https://github.com/cup-audio/cup/pull/54)), the whole-Worker integration tests ([#35](https://github.com/cup-audio/cup/pull/35)), the OpenAPI snapshots ([#38](https://github.com/cup-audio/cup/pull/38)), the documentation wiki and the Mermaid Live redraw of the architecture diagrams. These decisions were recorded from code comments on 2026-11-23.

## Decision

oxlint:

- The oxlint VS Code extension accepts the `maxWarnings` and `typeAware` options only in the root configuration file, which is the [`oxlint.config.ts`](../../oxlint.config.ts) of the folder opened in VS Code, the monorepo root. That file exists for the extension. Workspace projects pass `--type-aware` and `--max-warnings 0` on the command line instead, because setting them in a project's `oxlint.config.ts` breaks the extension ("The `options.typeAware` option is only supported in the root config").
- A package config or override that sets `no-restricted-imports` replaces the repository's options instead of merging with them, so [`restrictImports`](../../tooling/config-oxlint/oxlint-base.js) returns the repository's paths and patterns ahead of the given patterns.

Formatting and Markdown:

- [oxfmt](../../oxfmt.config.ts) ignores the OpenAPI snapshot files, which the snapshot tests write and compare byte for byte.
- [markdownlint](../../.markdownlint-cli2.mjs) turns the line-length rule (MD013) off: prose stays on one source line per paragraph, and the renderer handles wrapping. Claude Code subagent worktrees (`.claude/worktrees/`) are excluded in `.git/info/exclude`, which markdownlint's `gitignore` option does not read, so the config ignores them itself.

Knip ([knip.ts](../../knip.ts)):

- Wrangler loads module-only Worker entry points (`test/worker.ts`) from the `wrangler.test.jsonc` configs, and the registry's integration Worker with its Cloudflare virtual module; Knip cannot see these, so they are listed as entries.
- Playwright and Vite load the web app's component-testing modules indirectly; `fidelity-check/cli.ts` starts Playwright with `playwright.fidelity-check.config.ts`, which runs `fidelity-check/run.ts`. The live evals use separate Vitest discovery, so Knip cannot infer their entry points either.
- `cf` is an intentional CLI-only dependency that agents use for Cloudflare inspection. Zizmor is an external validation tool installed through `uvx`, not a Node dependency. The app E2E global setup signs the suite's local HTTPS certificate with the system's `openssl`.
- The test Worker's dependency on `@cup/cloudflare-worker` expresses the built-app test dependency graph for Turbo, not an import.

## Consequences

- Lint options that the extension reads only at the root must be repeated on each package's lint command line.
- A package that restricts imports must use `restrictImports`, or it silently drops the repository's restrictions.
- Each new Wrangler-loaded entry point or CLI-only dependency needs a Knip entry.

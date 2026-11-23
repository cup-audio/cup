---
status: accepted
---

# Order and cache validation gate steps by what each step reads

[ADR 0020](0020-validate-in-three-local-gates-that-trust-the-turbo-cache.md) introduced the review, merge and deploy gates ([#255](https://github.com/cup-audio/cup/pull/255)), and [ADR 0024](0024-replay-e2e-suite-passes-from-the-turbo-cache-with-a-toolchain-key.md) and [ADR 0026](0026-replay-mobile-e2e-passes-per-platform-and-run-both-platforms-in-parallel.md) replay E2E passes from the Turbo cache ([#312](https://github.com/cup-audio/cup/pull/312), [#305](https://github.com/cup-audio/cup/issues/305)). Further choices in the [gate runner](../../tooling/validation-gates/src/gates.ts), the [toolchain key reader](../../tooling/toolchain-key/src/playwright.ts) and the Turbo configs followed from what each step reads; they came with those changes, the "passed (replayed)" marking ([#302](https://github.com/cup-audio/cup/issues/302)), the native Android media player ([#401](https://github.com/cup-audio/cup/pull/401)) and the commit that stopped caching the workspace invariant tests. These decisions were recorded from code comments on 2026-11-23.

## Decision

Gates:

- Each gate includes every prerequisite and step of the gate before it: a later gate spreads its predecessor's `prerequisites` and `steps` and appends its own instead of repeating them.
- A gate checks every prerequisite before its first step. The test step runs the Android app's JVM unit tests through Gradle, which needs the Android SDK and Java 21; the mobile app's own check names what is missing and its fix, so its output is shown. The deploy gate runs the mobile E2E suite's own preflight check for both platforms up front, so a missing toolchain fails it before its first step rather than after the web suites.
- The deploy gate runs on exactly the commit being deployed: a clean `main` equal to a freshly fetched `origin/main`. A checkout is clean when no tracked file has uncommitted changes; untracked and ignored files, such as `.env.local`, do not count ([git.ts](../../tooling/validation-gates/src/git.ts)).
- The evals rule compares against `origin/main` as last fetched, so commits on a stale local `main` do not count as the branch's changes. The evals run outside Turbo, so the paid evals always run fresh. Turbo marks a package affected when its files or a dependency's files changed relative to the merge base with `origin/main`, uncommitted changes included.
- Knip loads the Worker's Vite config, which requires the built web app, so Knip runs after the build.
- A step that runs cached E2E suite tasks is marked: when Turbo reports every one of them as a cache hit, the step's result reads "passed (replayed)". The runner reads this from Turbo's output: `<package>:turbo:e2e: cache hit` (or `turbo:e2e:android`, `turbo:e2e:ios`) for a replayed task and `cache miss` for one it runs; the uncached toolchain-key task and the builds the suite depends on do not count. A teed step's output goes through a pipe, so Turbo is told to keep its colours.
- The [command runner](../../tooling/validation-gates/src/run-command.ts) runs commands from the repository root without a shell; a command that cannot start, such as a missing binary, resolves with exit code 127 instead of throwing. The [gate runner](../../tooling/validation-gates/src/run-gate.ts) names every failure in the summary, including an error from its own git or turbo calls, rather than throwing; the summary is Markdown meant to be posted verbatim. The summary's short SHA is marked when tracked files differ from it, since the gate then ran on other code.

Turbo:

- The root [turbo.jsonc](../../turbo.jsonc) lists the Worker's Wrangler config as a global dependency: library Worker types are generated from it, so its runtime changes must invalidate cached tasks.
- The [workspace checks](../../qa/workspace-checks/turbo.jsonc) are never cached: their tests read every workspace package's `package.json` and `.` export target, which the package's inputs don't cover, so a cached result would replay after another package breaks a rule. The tests take about a second, so they run every time.

Toolchain key reader for the Playwright suites:

- Each Docker call other than the image build is bounded, so an unresponsive Docker daemon cannot block the run. The image build gets the same bound as the shared configuration's global setup, since it pulls the Playwright base image and installs Playwright from npm.
- The Playwright version is resolved from the shared configuration, as its global setup does; the catalog gives the reader's own `@playwright/test` dependency the same version.
- The reader runs the same build as the global setup. Concurrent builds, such as the two Playwright suites' readers in one Turbo run, are identical and share BuildKit's layer cache, so they produce the same image.

## Consequences

- Adding a gate step means placing it after every step whose output it reads.
- The workspace checks cost about a second on every gate run in exchange for never replaying a stale pass.
- A gate summary always exists, pass or fail, so it can be posted as evidence.

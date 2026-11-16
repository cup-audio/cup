# Workspace checks

Tests for invariants that span every workspace package. Every [validation gate](../../AGENTS.md#validation-gates) runs them with the other package tests; run them alone with `pnpm --filter @cup/workspace-checks test`. Turbo never caches them, because they read files in every other package, outside this package's cache inputs.

## Package export check

The [package export test](test/package-exports.test.ts) lists the workspace projects with `pnpm ls --recursive --json --depth -1`, reads each `package.json`, and applies the [rule](src/package-exports.ts) to every project except the repository root and `.patricktree-stack`:

- In `apps/` and `libs/`, a subpath export whose target lies in `src/` is production code, unless the target is a `*.fake.ts` test double. Re-export production code from `.`, or list the subpath with its reason under `cup.subpathExportExceptions` in the same `package.json`.
- An entry in `cup.subpathExportExceptions` that no production subpath export needs fails the check, so stale exceptions do not accumulate.
- A `.` export whose file re-exports other files of the package must be `src/index.ts`.

Packages in `tooling/` and `qa/` hold no production code, so the check accepts any of their subpath exports. The [system overview](../../docs/architecture/README.md#responsibilities-and-code-boundaries) explains why the rule exists.

## Sentry SDK family check

Sentry's server SDK (`@sentry/cloudflare`) and its client SDK (`@sentry/capacitor` with `@sentry/react`) move on different majors, each with its own `@sentry/core`. The [SDK family test](test/sentry-sdk-families.test.ts) reads every package's dependencies, dev dependencies and peer dependencies and applies the [rule](src/sentry-sdk-families.ts):

- Only `@cup/telemetry.cloudflare` and packages that depend on it may depend on `@sentry/cloudflare`. Other server code that only captures, such as the API server, uses `@sentry/core` from the `sentry-server` catalog.
- Only `@cup/telemetry.browser` and `@cup/web-app` may depend on a client SDK (`@sentry/browser`, `@sentry/capacitor`, `@sentry/react`).
- No package depends on both families. A Sentry package belongs to the family of its SDK, or of its catalog (`catalog:sentry-server` or `catalog:sentry-client`) for a shared package such as `@sentry/core`. `@sentry/cli`, a build tool, belongs to neither.

The check reads declared dependencies, not import statements: pnpm's strict layout lets a package import only what it declares.

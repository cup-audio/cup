---
status: accepted
---

# Keep repository-wide invariants in workspace configuration and checks

Some rules span every package: which Sentry SDK family a package may use, how a package exports production code, which dependencies may run install scripts, and which version constraints hold dependencies together. They live in [pnpm-workspace.yaml](../../pnpm-workspace.yaml) and the [workspace checks](../../qa/workspace-checks). The Sentry families and their check came with Sentry reporting ([#422](https://github.com/cup-audio/cup/pull/422), issue [#403](https://github.com/cup-audio/cup/issues/403)); the export rule with [#53](https://github.com/cup-audio/cup/pull/53); the install-script decisions for Appium and WebdriverIO with the mobile E2E suite ([#211](https://github.com/cup-audio/cup/pull/211)); the Vitest constraint with [#458](https://github.com/cup-audio/cup/pull/458); the rest with release 1.0.0. These decisions were recorded from code comments on 2026-11-23.

## Decision

Sentry SDK families:

- Sentry's server SDK (`@sentry/cloudflare`) and its client SDK (`@sentry/capacitor` with `@sentry/react`) move on different majors, each with its own `@sentry/core`. The `sentry-server` and `sentry-client` catalogs keep the versions apart, and [sentry-sdk-families.ts](../../qa/workspace-checks/src/sentry-sdk-families.ts) keeps the packages apart, so the two majors never meet in one package. It checks three rules: only the server telemetry library and its dependents depend on the server SDK; only the browser telemetry library and the web app depend on a client SDK; and no package depends on both families. A Sentry package belongs to the family of its SDK, or of its catalog for a shared package such as `@sentry/core`.
- `@sentry/cloudflare` depends on exactly its own `@sentry/core` version, so both move together. `@sentry/capacitor` pins its own `@sentry/browser` and `@sentry/core` and peers on exactly one `@sentry/react`, so the client family moves only together with a `@sentry/capacitor` release.
- `@sentry/cli` is a build tool in neither family: it injects debug IDs and uploads source and debug files, next to either family.
- The mobile app runs no Sentry code; it declares `@sentry/capacitor` so that `cap sync` adds the SDK's native plugin to the shells.

Package exports ([package-exports.ts](../../qa/workspace-checks/src/package-exports.ts)):

- Production code is exported through `.`, which is `src/index.ts` when it re-exports other files. In `apps/` and `libs/`, the only directories holding production code, a subpath export pointing into `src/` is production code unless it is a `*.fake.ts` test double; such a subpath passes only when the package's `cup.subpathExportExceptions` lists it with a reason.
- The check supports a conditional export target only with a `default` condition; its test fails on one without, and the supported shape is extended when a package needs one.

Install scripts (`allowBuilds`):

- `@sentry/capacitor`'s postinstall only checks that the sibling SDK versions match, which the `sentry-client` catalog pins, and `@sentry/cli`'s downloads the binary only when the platform package (an optional dependency) is missing; both stay off.
- The mobile E2E suite installs its Appium drivers on its first run, never at install time. WebdriverIO pulls in desktop browser drivers (edgedriver, geckodriver) the mobile suite never uses; their scripts stay off.

Other constraints:

- Additional `.patricktree-stack` projects join the workspace only when this repository uses them.
- `vitest-evals` requires Vitest 5, so the runner and its coverage provider stay aligned on it.
- `eslint-plugin-react-you-might-not-need-an-effect` declares eslint as a peer dependency, which oxlint does not need, so a package extension makes it optional.
- The unpacked Gemini TTS listening comparison under `docs/research` is ignored by Git; its reproducible record is stored in its archive.

## Consequences

- Upgrading a Sentry SDK means moving its whole family, and a package that needs both families fails the workspace checks.
- A new subpath export into `src/` needs a recorded reason in its `package.json`.
- A new dependency with an install script stays inert until it is listed in `allowBuilds`.

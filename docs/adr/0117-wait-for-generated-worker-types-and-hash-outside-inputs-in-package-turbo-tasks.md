---
status: accepted
---

# Wait for generated Worker types and hash outside inputs in package Turbo tasks

[cup-audio/cup#22](https://github.com/cup-audio/cup/pull/22) stopped committing Worker types (`worker-configuration.d.ts`), which Wrangler now generates from each package's configuration, and commit 917158c6 made Turbo hash the files tests read outside their package. The shared duration ledger from [cup-audio/cup#17](https://github.com/cup-audio/cup/pull/17) compiles against Durable Object runtime types without being a Worker itself. These decisions were recorded from code comments on 2026-11-23.

## Decision

- Worker types are generated, not committed, so every Turbo task that typechecks a package, `turbo:build`, `turbo:lint`, `turbo:lint:fix` and `turbo:test`, depends on `turbo:cf-typegen` ([accounts](../../libs/accounts/turbo.jsonc), [conversion grants](../../libs/conversion-grants/turbo.jsonc), [duration ledger](../../libs/duration-ledger/turbo.jsonc), [registry](../../libs/registry/turbo.jsonc)).
- Each store's `sqlite-migrations.test.ts` checks the schema diagram on [Durable Object storage](../architecture/durable-object-storage.md), a page outside the package, so that page is an input of the package's `turbo:test`.
- The duration ledger's [test Wrangler configuration](../../libs/duration-ledger/wrangler.test.jsonc) only generates the Durable Object runtime types the ledger compiles against; no Worker runs it.

## Consequences

- A cached test result is invalidated when the storage page changes, so an outdated diagram cannot pass from the cache.
- A package that reads another file outside itself in tests must list it as an input the same way.

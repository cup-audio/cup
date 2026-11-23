---
status: accepted
---

# Keep Durable Object storage readable across migrations and rollbacks

The account, conversion grant and registry Durable Objects each keep SQLite storage whose schema is generated with Drizzle ([ADR 0004](0004-preserve-only-grants-during-drizzle-transition.md)). Stored rows outlive the code that wrote them, a deploy can be rolled back to code from before a migration, and Durable Object SQLite limits the shape of statements. These rules came from the account lifecycle work, shared grant rate events in [cup-audio/cup#16](https://github.com/cup-audio/cup/pull/16), the shared duration ledger in [cup-audio/cup#17](https://github.com/cup-audio/cup/pull/17), the operator inspection shapes in [cup-audio/cup#29](https://github.com/cup-audio/cup/pull/29), cover images in [cup-audio/cup#5](https://github.com/cup-audio/cup/pull/5), conversion deletion in [cup-audio/cup#138](https://github.com/cup-audio/cup/pull/138), and the stuck checks in [cup-audio/cup#422](https://github.com/cup-audio/cup/pull/422). They were recorded from code comments on 2026-11-23. [Durable Object storage](../architecture/durable-object-storage.md) describes the schemas, and the [migration generator](../../tooling/drizzle-migrations/README.md) how migrations are made.

## Decision

Shared tables reach every store through its own migrations:

- The [duration ledger](../../libs/duration-ledger/src/duration-ledger-schema.ts) tables are shared by every duration allowance owner, and each owner's Durable Object keeps its own copy. The [account](../../libs/accounts/src/storage/account-sqlite-schema.ts) and [grant](../../libs/conversion-grants/src/storage/grant-sqlite-schema.ts) schemas re-export them so that their migrations create them.
- Each store's `rate-limit-schema.ts` re-exports the shared rate-limit table from `@cup/rolling-limits` so the migration generator includes it in that store ([accounts](../../libs/accounts/src/storage/rate-limit-schema.ts), [grants](../../libs/conversion-grants/src/storage/rate-limit-schema.ts), [registry](../../libs/registry/src/storage/rate-limit-schema.ts)).
- Migration `0002_shared_rate_events` moved the grant's existing start attempts into the shared table under the bucket and 60-second window that the [grant Durable Object](../../libs/conversion-grants/src/durable-object/conversion-grant-durable-object.ts) uses, `START_RATE_BUCKET` and `START_RATE_WINDOW_MS`, so recent attempts keep counting toward the limit. Changing either constant must account for that.

Reads tolerate what older code stored or writes during a rollback:

- Code from before grant migration 0005 writes no stage start, so a row it writes during a rollback has none; the [grant storage](../../libs/conversion-grants/src/storage/grant-sqlite.ts) reads such a row the way the migration backfilled the rows it found.
- The deletion coordinator's `isStuckReported` defaults to false: jobs stored before the stuck check lack it, and code from before the check drops it when it saves a job during a rollback. The job then reads as unreported, so the worst case is one more report of the same attempt ([deletion coordinator](../../libs/registry/src/account-deletion/deletion-coordinator.ts)).
- A deletion notice stored before it carried its type has the type only in its key, `<attemptId>:<type>`, and is read from there.
- The account alarm recorded a preparation Workflow that errored or was terminated as `execution-failed` until it took the conversion grant's category; stored outcomes keep it, and the [account contracts](../../libs/accounts/src/domain/account-contracts.ts) read it as `workflow-platform`.
- Optional outcome fields such as `hasCoverImage` are recorded only when the audiobook has one, so stored outcomes without them keep their fingerprint, and a replayed grant outcome without one still matches ([grant model](../../libs/conversion-grants/src/domain/grant-model.ts)).

Statement shapes:

- Durable Object SQL binds at most 100 parameters per statement ([limits](https://developers.cloudflare.com/durable-objects/platform/limits/)), so the [registry storage](../../libs/registry/src/storage/registry-sqlite.ts) inserts grants in batches sized from that limit, and callers hold a storage transaction across the delete and every insert batch.
- A conversion can have more artifact writers than SQLite binds parameters, so the [account artifact writers](../../libs/accounts/src/storage/account-artifact-writers.ts) delete drained writers with one statement per writer.

Migration testing:

- The registry tests replay migrations against a frozen production schema from commit c970a6e, kept in [fixtures](../../libs/registry/test/fixtures/production-grant.sql) independently of the generated Drizzle schemas.

More rules from the [account](../../libs/accounts/src/storage/account-sqlite.ts) and grant storage:

- Code from before account migration 0011 writes no stage start either; such a row reads the way that migration backfilled the rows it found.
- A conversion's narration language is null when its audiobook has none or was prepared before narration languages were recorded.
- Parsing a stored outcome restores its exact shape, so settlement replays compare equal fingerprints.
- The Durable Object migrator runs migrations in one transaction with enforced foreign keys, and the migration tests run them the same way.
- Test fixtures that insert many rows stay below the variable limit of a Durable Object's SQLite per statement.

## Consequences

- A migration that adds a column must leave rows written without it readable, because rolled-back code keeps writing such rows.
- The reading shims stay as long as stored rows of the older shape can exist.
- The migration SQL files keep their own header comments, since each file is mirrored byte for byte in the generated migration bundle.

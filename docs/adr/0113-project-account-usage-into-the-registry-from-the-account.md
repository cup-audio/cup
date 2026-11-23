---
status: accepted
---

# Project account usage into the registry from the authoritative account

Operator account listings need every account's duration usage, but each account keeps its duration ledger in its own Durable Object, and listing accounts must not call every account. [cup-audio/cup#20](https://github.com/cup-audio/cup/pull/20) added a usage projection that the registry keeps beside each identity mapping, and [cup-audio/cup#422](https://github.com/cup-audio/cup/pull/422) refined its alarm handling. These decisions were recorded from code comments on 2026-11-23. [Durable Object storage](../architecture/durable-object-storage.md) and [observability operations](../architecture/observability-operations.md) describe the stores.

## Decision

- **The account is authoritative.** The projection is the account's duration usage as the registry keeps it for operator listings. A `revision`, the duration ledger revision, orders projections, so the registry never replaces newer usage with older ([account contracts](../../libs/accounts/src/domain/account-contracts.ts)). A projection version increases when a projected field changes meaning, so the registry can tell older projections apart.
- **The account pushes.** The account records which ledger revision the registry last confirmed and pushes its projection when the registry has not confirmed the current one ([account Durable Object](../../libs/accounts/src/durable-object/account-durable-object.ts)). The projection is derived from the ledger, so a failed push is safe to retry indefinitely; the alarm retries until the registry confirms this or a later revision. While the registry lags the ledger, the account arms its alarm without postponing an earlier one. Operators list accounts right after adjusting them, so an operator adjustment pushes the projection at once.
- **The registry pulls what it lacks.** The registry pulls usage for accounts whose projection it lacks, such as new accounts ([registry Durable Object](../../libs/registry/src/durable-object/registry-durable-object.ts)). Provisioning activates an account before pulling its usage, so only active accounts are owed one. Repeat sign-ins also provision; afterwards the account keeps its own projection current. A failed pull during provisioning is left to the alarm.
- **The registry's alarm backfills.** Accounts that existed before usage projections, or whose first pull failed, converge through the alarm's backfill, which the registry arms on startup when such accounts exist. A batch size bounds the account RPCs one alarm makes while backfilling.
- **Migrations start unconfirmed.** The account migration that added the confirmed revision and the registry migration that added the projection columns copy only existing columns, so every account starts unconfirmed and publishes its usage on its next alarm or registry pull, and every registry row starts without a projection until the alarm pulls one.

- **Ordering and idempotency.** Confirmations can arrive out of order, so the account's confirmed revision only moves forward ([account storage](../../libs/accounts/src/storage/account-sqlite.ts)). The registry keeps the newest projection an account pushed: a late delivery of an older one is ignored, and a repeated delivery must match what was stored. Its projection columns stay null until it first receives one ([registry schema](../../libs/registry/src/storage/registry-sqlite-schema.ts)). A registry pull also confirms the usage at the account, so the account need not push it again.
- **Backfill placement.** The backfill runs last in the registry's alarm pass, because it calls account objects that may be slow and the work before it is time-critical. One unavailable account must not stall the rest; the next alarm retries it.
- **Listings.** Operator account listings use keyset pagination, which keeps pages stable while new identities are provisioned between requests.

## Consequences

- Operator listings may briefly show older usage until the account's push or the registry's pull lands; the revision prevents them from going backwards.
- A registry outage delays projections but loses nothing: the account's alarm keeps retrying.

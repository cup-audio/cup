---
status: accepted
---

# Keep each owner's duration allowance in a shared append-only ledger

Accounts and conversion grants both own a duration allowance of generated audio, reserve it for a narration document, and charge each segment's encoded duration. [cup-audio/cup#17](https://github.com/cup-audio/cup/pull/17) moved both owners onto one shared duration ledger in [`@cup/duration-ledger`](../../libs/duration-ledger/src/duration-ledger.ts); [cup-audio/cup#20](https://github.com/cup-audio/cup/pull/20) projected its usage into the registry, and [cup-audio/cup#488](https://github.com/cup-audio/cup/pull/488) exposed its events to the operator. These decisions were recorded from code comments on 2026-11-23. [Durable Object storage](../architecture/durable-object-storage.md) describes the tables, and [ADR 0008](0008-synthesize-the-whole-narration-document.md) the whole-document reservation.

## Decision

- **Append-only ledger, cached balance.** The ledger keeps one owner's duration allowance, reservations and encoded-duration charges as append-only events. The balance row caches the ledger's sums so that checks stay cheap.
- **One copy per owner.** The ledger tables are shared by every duration allowance owner, but each owner's Durable Object keeps its own copy, created by the owner's own migrations ([storage ADR](0111-keep-durable-object-storage-readable-across-migrations-and-rollbacks.md)).
- **Ledger operations own duration.** In the grant, segment usage and duration totals are read from the ledger; ledger operations change them, not saving the grant record, and the [grant storage](../../libs/conversion-grants/src/storage/grant-sqlite.ts) saves the grant and its conversions while duration changes go through the ledger.
- **Event causes.** Segment events (`reserve`, `consume`, `release`) carry the conversion ID as their cause and keep it after the conversion is deleted; `grant` and `adjustment` events carry the welcome version or the operator's reason ([account contracts](../../libs/accounts/src/domain/account-contracts.ts)).
- **Overruns.** Available duration matches the owner's balance: an overrun can leave reserved and spent duration above the allowance until reservations settle, and the balance then reports no availability ([registry model](../../libs/registry/src/domain/registry-model.ts)).

- **Revision.** The ledger's revision orders its states: every change to the allowance, reserved or spent duration appends an event, and events are never removed, so the event count grows with each change and only then.
- **Reservations.** A reservation takes every segment lacking audio, or none when their whole estimate exceeds the available duration. `refuseNewReservations` lets the owner refuse when anything would be reserved, while a request that only finds existing reservations still succeeds; an expired or revoked grant uses it, so it refuses new reservations while existing ones remain. Each segment references the reservation operation currently backing it, and a re-reservation replaces it. Only the referenced conversion table differs between owners, so each owner schema passes its own conversion ID column ([ledger schema](../../libs/duration-ledger/src/duration-ledger-schema.ts)).
- **Overrun charges.** An overrun can temporarily exceed the unreserved balance: the ledger keeps other reservations intact, caps total charges at the remaining allowance, and exposes zero availability until they settle.
- **Adjustments.** An allowance change is signed and recorded once per request ID, so retrying with the same request ID replays a recorded adjustment and failures stay safe to retry ([server composition](../../libs/api-server/src/api-server.ts)). A reduction may not exceed the available duration, so reserved and spent duration always stay covered. For a grant the operator sets a target allowance, and the ledger records the difference as an adjustment.
- **Paging.** Ledger events are paged in append order by their implicit SQLite rowid. The ledger never deletes an event before the whole owner is erased, and Durable Object storage is never vacuumed, so rowids only grow and paging by them never skips or repeats an event. The account's cursor is the decimal position of the page's last event; a malformed cursor fails rather than restarting from the first event. The operator's ledger pages keep the entries of deleted conversions.

## Consequences

- Changing an owner's duration outside ledger operations leaves the cached balance and the events disagreeing.
- Operator inspection can trace every reservation and charge back to its conversion, also after the conversion is deleted.

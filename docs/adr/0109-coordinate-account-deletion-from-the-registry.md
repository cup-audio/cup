---
status: accepted
---

# Coordinate account deletion from the registry, apart from the account being erased

Account deletion removes the account's data, its Supabase identity and its routes, and sends notices by email; the account Durable Object cannot own work that must outlive its own erasure. The account lifecycle work introduced the registry's deletion coordinator and the account's lifecycle outbox, [cup-audio/cup#37](https://github.com/cup-audio/cup/pull/37) and [cup-audio/cup#45](https://github.com/cup-audio/cup/pull/45) moved its Resend and Supabase calls into providers, and [cup-audio/cup#138](https://github.com/cup-audio/cup/pull/138) added conversion deletion. These decisions were recorded from code comments on 2026-11-23. [Account deletion](../architecture/account-deletion.md) describes the flow.

## Decision

- **The coordinator owns the intent.** The registry's [deletion coordinator](../../libs/registry/src/account-deletion/deletion-coordinator.ts) owns cleanup and notification intent independently of the account being erased.
- **The account delivers through an outbox.** The account's [lifecycle](../../libs/accounts/src/storage/account-lifecycle.ts) makes its local transitions atomically; delivery to the registry is a persisted, replayable outbox. Stored deletion attempts never reach `erased`, because account erasure deletes their rows.
- **Authoritative identity checks.** Before the registry allocates an account, an authoritative existence check against Supabase prevents expired or deleted identities from allocating accounts ([Supabase identity](../../libs/registry/src/providers/supabase-identity.ts)).
- **Resend sends.** [Resend sends](../../libs/registry/src/providers/resend-email.ts) carry an idempotency key, since Resend deduplicates sends with the same key inside its deduplication window. A `rejected` outcome is final; `retry` covers other failures, timeouts and lost responses. The send's `nowMs` anchors a `Retry-After` given as an HTTP date.
- **Provider calls are injectable.** The coordinator takes its outgoing request function as an option so tests can drive local stand-ins. Workers reject `fetch` called as a method of another object, so the default wraps `fetch` in a function.
- **Conversion owners.** The registry removes conversion owners one at a time only for account conversions, so a trial owner is never removed that way ([registry storage](../../libs/registry/src/storage/registry-sqlite.ts)).

- **Lifecycle states.** Deletion challenges are refused once deletion has started, so they never record `deleting` ([account schema](../../libs/accounts/src/storage/account-sqlite-schema.ts)).
- **Interleaving.** The coordinator's input gate stays open while an account RPC is pending, so a restore or a Google revocation outcome may have been accepted meanwhile; the coordinator continues from the stored job, not its in-memory copy, and a restore accepted while a failed call was pending supersedes the attempt.
- **Independent retries.** Identity unavailability must not block independent Cup storage cleanup. The durable alarm retries the exact identity, and undrained writers or a storage outage leave the account pending until the alarm retries it. Deleting the Supabase identity is a hard delete; an identity that is already gone counts as deleted.
- **Notice sends.** The notice's intent and send window are stored before the ambiguous HTTP call, and a retry replays the immutable idempotency key only inside the provider's deduplication window. Resend refuses requests without a `User-Agent` with 403, so every send sets one.
- **Privacy.** A deletion's log records carry its opaque IDs, never its subject or email address, and a record of a notice that ended `failed` or `expired` carries its type and attempt, never its address.

## Consequences

- A notice can be retried after a lost response without sending it twice, as long as the retry stays inside Resend's deduplication window.
- Replacing the default request function with a bare `fetch` reference breaks provider calls in the Worker.

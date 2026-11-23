---
status: accepted
---

# Reconcile account conversions and conversion deletions in the account alarm

The [account Durable Object](../../libs/accounts/src/durable-object/account-durable-object.ts) starts preparation and synthesis Workflows, writes to R2 through artifact writers, and deletes conversions ([ADR 0015](0015-fence-conversion-deletion-with-a-durable-marker-on-the-account-conversion-row.md)). Any of these can stop partway when the object is evicted, a Workflow or R2 call fails, or two requests interleave. The account therefore persists intent first and lets its alarm finish the work. The rules were introduced with the account lifecycle and the preparation Workflow, whole-document synthesis ([ADR 0008](0008-synthesize-the-whole-narration-document.md)), conversion deletion in [cup-audio/cup#138](https://github.com/cup-audio/cup/pull/138), the faster deletion response in [cup-audio/cup#166](https://github.com/cup-audio/cup/pull/166) (CUP-48), Sentry reporting in [cup-audio/cup#422](https://github.com/cup-audio/cup/pull/422), and Workflow termination warnings in [cup-audio/cup#490](https://github.com/cup-audio/cup/pull/490). They were recorded from code comments on 2026-11-23. [Conversion](../architecture/conversion.md) and [conversion deletion](../architecture/conversion-deletion.md) describe the flows.

## Decision

Dispatch and recovery:

- When the API accepts a conversion, the committed pending conversion and its stable ID are the recovery authority, and a reconciliation alarm can safely retry the exact same Workflow identity ([start audiobook conversion](../../libs/api-server/src/use-cases/start-audiobook-conversion.ts)).
- A ready outcome that reserves the whole narration document arms the alarm, which dispatches reserved segments if the Workflow never gets to them. Before dispatching segments, the account arms the alarm, which completes a dispatch that fails partway.
- Segment dispatch runs inside `blockConcurrencyWhile`, so concurrent retries do not restart each other's instances. A throw inside that gate would reset the object, so a dispatch failure is carried out of the gate first.
- Recording a phase checks the execution and writes the phase in one synchronous call, so a fenced execution cannot record a phase between the check and the write.
- When starting the preparation Workflow fails, the account restarts the existing instance; the restart also covers the brief interval between recording a failure and platform termination.
- A failed preparation dispatch keeps its persisted intent, so the alarm retries it. A conversion deletion, even its whole cleanup, can land while the registry bind of its owner is in flight, so the bind may have recreated an owner the cleanup already removed; the account removes it again.

The alarm pass:

- A pass re-arms the alarm before any external call, so abrupt termination cannot lose dispatch intent.
- It terminates the Workflows of deleted conversions first: ahead of cleanup, which deletes the segment rows this step reads, and ahead of every step that can throw.
- Account erasure sweeps the whole account, so it subsumes any conversion cleanup still owed, and a pass for a `deleting` account stops there.
- A step that throws fails the pass, which captures the error and lets the platform retry the alarm. The registry's alarm follows the same rule.

Conversion deletion (beyond ADR 0015's marker):

- The deletion request marks the conversion and releases its open reservations, then arms the alarm, which terminates the conversion's Workflows, cleans it up, and also publishes the usage the release changed.
- A conversion can be marked without an armed alarm, such as one marked before the alarm cleaned up conversions or one whose deletion crashed before arming it, so the account arms one when it finds such a conversion.
- Cleanup runs idempotent steps per marked conversion. A step that cannot finish leaves the conversion marked, so the alarm stays armed and the next pass retries it from the start; one conversion's failure never blocks another's. The alarm reconciles every artifact writer first; one still running may yet land a put, so cleanup waits for it.
- R2 has no prefix delete and deletes at most 1,000 keys per call, so cleanup lists and deletes in batches.
- Workflow termination only saves cost: the marker already fences whatever still runs, and a terminated instance can still land its running step. Each instance is tried once, and a failure is only logged, neither retried nor recorded. `get()` throws for an instance that does not exist. Per Cloudflare's [`WorkflowInstance` documentation](https://developers.cloudflare.com/workflows/build/workers-api/), `terminate()` throws for an instance that has finished (`complete`, `errored` or `terminated`), which needs no termination, so its rejected attempt logs nothing. An instance whose status cannot be read counts as unfinished, and the warning then carries the termination error, which is the one that matters for cost; the status error is dropped.

Artifact writers ([account artifact writers](../../libs/accounts/src/storage/account-artifact-writers.ts), [artifact writer](../../libs/accounts/src/artifacts/artifact-writer.ts)):

- The account tracks its storage effects so deletion waits for acknowledged production writes. Every write is registered before R2 receives it, and only acknowledged writes can drain.
- Writer prefixes can be nested below the conversion prefix, such as an execution's prefix.
- `writers()` lists only writers that are not drained, but the operator inspection schema accepts every stored state.

Workflow termination and cleanup in the [account storage](../../libs/accounts/src/storage/account-sqlite.ts):

- A marked conversion gets one attempt to terminate its Workflows. The alarm records taking it ahead of the attempt, which returns the segment sequences whose Workflows may still run, so an alarm that dies partway through a long conversion's Workflows does not start over on every pass.
- Marked conversions are listed oldest marker first. Each still owes cleanup, and the alarm stays armed while any is listed.
- The last cleanup step deletes a marked conversion's rows in one transaction, the marked row last because the other rows reference it. Ledger history stays, since segments only reference their credit operations. An unmarked conversion is never touched.

The [conversion grant Durable Object](../../libs/conversion-grants/src/durable-object/conversion-grant-durable-object.ts) follows the same rules for trial conversions:

- It records a start attempt for the rate limit before checking grant state, so starts on closed grants count too.
- Its segment dispatch runs in the same `blockConcurrencyWhile` gate with the failure carried out of it, and its alarm completes a dispatch that fails partway; a failed preparation dispatch pass is logged and the alarm retries it.
- Recording an outcome must not fail a settlement that already happened.
- An alarm pass that throws fails, captures the error and lets the platform retry; only the stuck-conversion check reads `nowMs`.
- A preparation whose dispatch never arrived has no instance, which is expected and not logged. When the platform's result is ambiguous, the same stable identity remains reserved, and reservations are not released for work that might still be running.
- The registry snapshot is derived, so publishing it is safe to retry indefinitely.
- Reserved work may finish after the grant expires or is revoked, so a grant can always resume it.

## Consequences

- Every new account step that calls out of the Durable Object must leave persisted intent that the alarm can finish, and must be safe to repeat.
- A stuck step keeps the alarm armed indefinitely; the stuck checks report it rather than giving up.

---
status: accepted
---

# Alert on stuck conversions, stuck deletions and stopped Workflows from the owners' alarms

A conversion whose preparation or synthesis stops making progress, a conversion or account deletion that never finishes, and a Workflow instance that stops without recording its outcome all fail silently unless something reports them. [cup-audio/cup#422](https://github.com/cup-audio/cup/pull/422) (squashing #403) added these reports to the alarms of the account and conversion grant Durable Objects and of the registry's deletion coordinator, building on the last started phase from [cup-audio/cup#101](https://github.com/cup-audio/cup/pull/101). These decisions were recorded from code comments on 2026-11-23. [Conversion](../architecture/conversion.md), [conversion deletion](../architecture/conversion-deletion.md) and [observability operations](../architecture/observability-operations.md) describe the checks.

## Decision

- **Stages.** A conversion's current stage started at acceptance while it is pending (preparation) and when it became ready once it is ready (synthesis) ([account storage](../../libs/accounts/src/storage/account-sqlite.ts), [grant model](../../libs/conversion-grants/src/domain/grant-model.ts)). The owner records when the stuck check reported the current stage, and a stage start removes that record. A settled conversion keeps the preparation phase it last started ([account contracts](../../libs/accounts/src/domain/account-contracts.ts)).
- **One event per stuck case.** The account alarm sends one Sentry event per stuck conversion and stage, and one per stuck conversion deletion ([account Durable Object](../../libs/accounts/src/durable-object/account-durable-object.ts)).
- **Placement in the pass.** The stuck checks run in a `finally` after the other steps: also after a step that threw, so a failing step cannot hide a stuck case, and after the cleanup, so a deletion that finished in this pass is not reported. Only the stuck checks read the pass's `nowMs`, so tests can choose it.
- **Stopped Workflows.** When the alarm finds a preparation instance that stopped without recording a failed outcome, or a segment instance that stopped without releasing its segment, nothing has captured it yet, so the alarm reports it.
- **Stuck account deletions.** An unfinished account deletion counts as stuck a fixed time after its recovery deadline: the coordinator's alarm reports it to Sentry once, and the operator API's `overdue` field is true for it ([deletion coordinator](../../libs/registry/src/account-deletion/deletion-coordinator.ts)).

- **When a stage starts.** Preparation starts when the conversion is accepted or retried, while it is pending; synthesis starts whenever segments are reserved, once it is ready, so a reservation of any missing segment starts synthesis again ([account schema](../../libs/accounts/src/storage/account-sqlite-schema.ts), [grant schema](../../libs/conversion-grants/src/storage/grant-sqlite-schema.ts)). Settling keeps the phase the conversion last started, as grants do; callers check the execution first. The migrations that added stage starts set existing rows to their completion or creation time.
- **Deletion reports.** The stuck-conversion-deletion report is recorded on the marked conversion and never clears, because the row goes once the cleanup finishes.
- **The grant's alarm.** The grant's stuck check also runs after a step that threw, and a pending conversion keeps the grant's alarm armed until the check has reported it.
- **Stuck account deletions, in detail.** An attempt is stuck when it is still neither erased nor restored an hour after its recovery deadline. Each stuck attempt is reported once, whether or not that pass retried it. The events of stuck attempts all group into one Sentry issue and never carry the email address. A scheduled job that has not fenced the account yet counts as account cleanup.

## Consequences

- The migrations that added stage starts backfilled preparation from acceptance and synthesis from becoming ready; a retry before those migrations is not recorded, so a retried conversion counts from its acceptance.
- Each stuck case is reported once per stage.

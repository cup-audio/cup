---
status: accepted
---

# Report stuck conversions and conversion deletions by age, once per case

A conversion can hang without anything failing: a Workflow that never finishes, a segment that keeps its reservation, a conversion deletion that silently waits. No error is thrown, so nothing reaches Sentry unless an owner looks for it. The owners' alarms therefore run stuck checks ([stuck check loop](../../libs/telemetry.cloudflare/src/stuck-check.ts)). They were decided with the observability spec [cup-audio/cup#403](https://github.com/cup-audio/cup/issues/403) for Linear CUP-37 and implemented in [cup-audio/cup#422](https://github.com/cup-audio/cup/pull/422). These decisions were recorded from code comments on 2026-11-23.

## Decision

- **One loop for every stuck check.** For each case that is stuck at `nowMs`, the loop sends one Sentry error event and returns the IDs of the cases it reported, so the owner stores that the event was sent and skips them from then on. Each event's message names its case, and a fixed fingerprint groups a check's cases into one Sentry issue.
- **Stuck conversions** ([check](../../libs/telemetry.cloudflare/src/stuck-conversion.ts)), run by both owners' alarms: a conversion is stuck in preparation when it is still `pending` 15 minutes after preparation started (accepted or retried), and stuck in synthesis when a segment still holds a reservation 60 minutes after synthesis started again. The owner passes only conversions whose current stage the check has not reported and skips a reported conversion until its stage starts again. All events of a stage share one fingerprint, so they group into one issue per stage. The thresholds are deliberately generous, so that only a hung Workflow or segment crosses them.
- **Stuck conversion deletions** ([check](../../libs/telemetry.cloudflare/src/stuck-conversion-deletion.ts)), run by the account alarm: a conversion still marked for deletion more than one hour after it was marked is stuck. The check uses age, not attempts: a cleanup that silently waits on undrained artifact writers fails no pass, yet still counts. The event names no root cause; the per-pass `conversion-deletion-cleanup-failed` warnings hold it.
- **A stopped Workflow is captured when the alarm settles it** ([stopped Workflow](../../libs/telemetry.cloudflare/src/stopped-workflow.ts)): a Workflow instance that stopped without recording its own failure, such as one the platform terminated or one that died outside its failure handling, is captured when the owner's alarm turns it into a failed conversion outcome or a finally failed segment. Its message names the conversion and sequence, so each stopped instance's event says which. The event ID is returned, and a trial conversion stores it as its `diagnosticReference`. It is captured in the alarm iteration's conversion scope, which supplies the conversion and owner tags. A preparation run that stops without a recorded outcome, for example because its grant refuses each phase it records, the finalization of its failure included, is left for the owner's alarm to capture as a stopped Workflow; capturing it in the run too would open two issues.

## Consequences

- Each stuck case alerts once, in one issue per check or stage, instead of on every alarm pass.
- The thresholds are meant to be tightened once conversion durations are visible in Sentry; issue draft G-1 tracks it.

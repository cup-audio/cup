---
status: accepted
---

# Work around Cloudflare Workflows behaviour in the conversion workflows

The [create-audiobook-from-URL workflow library](../../libs/create-audiobook-from-url-workflow/) runs preparation and segment synthesis as Cloudflare Workflows. The engine stores each step's result under the step's name, replays recorded steps after a restart, retries failed steps, and rebuilds a failed step's error. Sentry reporting arrived in [cup-audio/cup#422](https://github.com/cup-audio/cup/pull/422) (for [cup-audio/cup#403](https://github.com/cup-audio/cup/issues/403)); the cover image steps in [cup-audio/cup#5](https://github.com/cup-audio/cup/pull/5); whole-document synthesis in commit `1e83af24` ([ADR 0008](0008-synthesize-the-whole-narration-document.md)). These decisions were recorded from code comments on 2026-11-23.

## Decision

- **Capture a failed step's own error.** [`keep-step-errors.ts`](../../libs/create-audiobook-from-url-workflow/src/keep-step-errors.ts) wraps a run's Workflow step so that the run can capture the error a failed step's callback threw; `originalStepError` finds it from the error the engine rebuilt. The engine rebuilds a failed step's error without own properties or `cause`, which drops the brand of a `CupError` and the exception chain, so telemetry would treat Cup's own error as foreign and send it without its message. Both [preparation](../../libs/create-audiobook-from-url-workflow/src/run-prepare-audiobook-workflow.ts) and [segment synthesis](../../libs/create-audiobook-from-url-workflow/src/run-audio-segment-workflow.ts) use the wrapper, so Cup's errors keep their messages.
  - `step.do` still rejects with the rebuilt error, so everything but telemetry behaves as before, such as a failed segment's explanation, whose text the engine prefixes with `NonRetryableError:` and a space for that error.
  - The original stays in this run's memory only; after an engine restart, a replay of the run skips the failed step's callback and has only the rebuilt error, which then reaches telemetry as foreign. A foreign error the callback threw stays foreign either way and loses its message.
  - Only the error of the latest attempt counts: an earlier attempt that timed out can still throw while a later one runs, and a last attempt that timed out threw nothing of its own.
  - `do` takes its callback either second or third, after an optional config, and an optional rollback after it. The wrapper calls it through `Reflect` because no overload of `do` takes the arguments as one list.
- **Step names are storage keys.** [`phase-step-name.ts`](../../libs/create-audiobook-from-url-workflow/src/phase-step-name.ts) names a step after the conversion phase it belongs to, followed by what it does. Sentry names each step's span after the step, so the trace shows where a conversion spends its time. A step's name is also the key under which Cloudflare Workflows stores its result, so renaming a step makes an instance that is running during the deploy run that step again.
- **Replays rerun code between steps.** The engine reruns the code between steps whenever it replays a run and reuses each step's recorded result. So:
  - A log record is written in a step of its own that never retries, so a replay reuses its recorded result instead of writing it again; such a log step must not fail the conversion and never rejects. The narration language warnings are logged in one step for the same reason.
  - Failure capture is the last thing in the step that records the failure, so only a run whose owner recorded the failure (for a segment, only a step that released the reservation) reports it, and a replay reuses the recorded step instead of capturing again. A preparation run that cannot record its failure stops, and the owner's alarm captures the stopped Workflow.
  - A content limit is an expected outcome, recorded by the `content-limit` warning inside a step that never retries. Any other failure is captured once its outcome is recorded, under an event ID chosen beforehand, so that the outcome can carry it as its diagnostic reference.
  - Each synthesis step counts the run's attempts so far: its own plus those that the steps before a rate limit wait returned. The release after a final failure reports the count of the step that ran last; a replay skips step callbacks, so a release after a replay reports none.
- **Renamed steps for changed results.** The step that segments the narration source material is named apart from the step that returned the whole narration document, so a run that recorded that step before the deploy runs the new one instead of reusing its result.
- **Step results stay small.** Cover image bytes are stored inside the step because a step result cannot carry them.
- **One identity per unit.** One stable Workflow identity serializes synthesis and retries for a unit across all players.
- **Reservations and ownership.** Reservations are taken for the whole document by the owner; a segment only checks its own. The [conversion execution](../../libs/create-audiobook-from-url-workflow/src/conversion-execution.ts) captures ownership and epoch, while the execution checks remain in the owner RPCs and the artifact writer.
- **Segment failures release.** Loading the narration is inside the segment's `try`, so a segment whose narration cannot be loaded fails finally too: it is released and captured instead of left reserved for the alarm to restart. Only the loaded manifest decides the narration language, so retries keep the stored one.
- **Dispatch after the ready outcome.** The ready outcome already reserved every segment or none. Insufficient duration is a valid result that leaves nothing to dispatch, and the owner's alarm dispatches if the dispatch step fails.
- **Rate limits wait.** A provider rate limit clears only after its per-minute window passes, and the whole narration document is dispatched at once, so a burst can exceed it; waiting outlasts that window instead of failing the segment ([ADR 0008](0008-synthesize-the-whole-narration-document.md)).
- **Preparation steps.**
  - One retry covers a browser launch or connection that failed transiently; a cover image refusal does not throw.
  - The cover image step opens a second browser session, after source preparation closed the first, so the step is self-contained and safe to retry ([prepare audiobook workflow](../../libs/create-audiobook-from-url-workflow/src/prepare-audiobook-workflow.ts)).
  - The cover image load is started beside narration content selection and awaited only before the manifest is stored, so a slow image host does not delay selection. It is assigned once source preparation has finished, and it never rejects.
  - A failing preparation lets a cover image step that is still running finish first, so it cannot write into the conversion's prefix after the owner has started cleaning up the failed conversion. Every cover image failure leaves the audiobook without one instead of failing the conversion.
  - Narration language detection runs in one retryable step and never rejects: when the step's retries are exhausted, or the answer is unusable, it falls back to the declared language or to none, and logs the fallback. A narration language the speech model cannot speak stays the narration language and is logged on its own, also when it came from a fallback; a speech provider that ignores the narration language, such as ElevenLabs, logs nothing.
- **Tests.**
  - The [provider failure tests](../../libs/create-audiobook-from-url-workflow/test/provider-failure.test.ts) mock `captureException` and `logEvent`: the Worker's failure tests check the event that reaches the Sentry stub, and the helper itself is tested against the Sentry stub in `@cup/telemetry.cloudflare`.
  - Wrangler's RPC transport can hide the original rejection, so tests of a failing segment verify its storage effects rather than the rejection.
  - Many tests run a whole conversion against Durable Objects in a Wrangler test harness, which outlasted Vitest's 5 s default under a full parallel test run, though each passes alone, so the [Vitest config](../../libs/create-audiobook-from-url-workflow/vitest.config.ts) raises the test timeout to 20 s.

## Consequences

- Renaming a step is a deploy-time change for running instances.
- After an engine restart, a failed step's Cup error reaches Sentry as foreign.

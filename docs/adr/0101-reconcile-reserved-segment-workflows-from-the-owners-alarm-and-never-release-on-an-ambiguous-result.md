---
status: accepted
---

# Reconcile reserved segment Workflows from the owner's alarm, and never release on an ambiguous result

Each audio segment is synthesized by its own Cloudflare Workflow instance, and the owner holds a duration reservation for the segment until synthesis reports an outcome ([ADR 0008](0008-synthesize-the-whole-narration-document.md)). Dispatching and checking these instances talks to the Workflows platform, whose calls can fail, time out or answer ambiguously. The dispatch and reconciliation in [`@cup/conversion-contracts`](../../libs/conversion-contracts/src/index.ts) date from commit 7f62af1a (prepare articles before progressive speech synthesis) and commit 1e83af24 (synthesize the whole narration document, 2026-10-11); the attempt count came with [cup-audio/cup#422](https://github.com/cup-audio/cup/pull/422). These decisions were recorded from code comments on 2026-11-23.

## Decision

- **A reservation means synthesis is owed.** The owner's alarm checks each reserved segment's instance: a missing instance is created, because dispatch never reached it. An errored instance is restarted, because it either predates this reservation (a retry's dispatch failed before reaching it) or stopped without releasing; a run that fails again releases the reservation itself. When the owner can no longer execute work, or the instance was terminated, the segment is reported so the owner releases the reservation.
- **An ambiguous platform result releases nothing.** When the instance's status cannot be read, or a restart fails, the segment stays in progress and its reservation stays until synthesis reports an outcome; the next alarm checks again, because releasing could release work that might still be running.
- **Creation is resolved through the stable instance ID.** A creation can succeed before its response is lost, so a failed `create` is followed by a lookup of the instance under its deterministic segment Workflow ID.
- **Dispatch runs under the owner's concurrency gate**, so explicit retries cannot restart each other's instances.
- **One dispatch has at most 25 creation requests in flight.** This bounds concurrency only; it does not enforce the Workflows limit on instance creations per second: creations are not paced, and owners do not coordinate. A creation refused for that limit fails the dispatch, which the caller retries and the owner alarm completes.
- **The attempt count a segment Workflow reports with its outcome** is absent after a replay of the run, and otherwise a positive safe integer.

## Consequences

- A reservation can outlive its Workflow by up to one alarm interval, and longer while the platform answers ambiguously; the stuck-conversion check reports a segment reserved for too long.
- A large conversion's dispatch can hit the per-second creation limit and finish only through the alarm; issue draft G-2 tracks pacing creations.

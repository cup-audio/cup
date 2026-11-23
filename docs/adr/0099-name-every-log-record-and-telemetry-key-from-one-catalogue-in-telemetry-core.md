---
status: accepted
---

# Name every log record and telemetry key from one catalogue in telemetry.core

The operator finds failures and outcomes in Sentry by saved queries and alerts on log event names and attribute keys, so those names must be stable and their meaning written down in one place. [`@cup/telemetry.core`](../../libs/telemetry.core/src/) holds the catalogue for every runtime. It was decided with the observability spec [cup-audio/cup#403](https://github.com/cup-audio/cup/issues/403) for Linear CUP-37 and implemented in [cup-audio/cup#422](https://github.com/cup-audio/cup/pull/422). These decisions, and the meaning of each event and key below, were recorded from code comments on 2026-11-23.

## Decision

- **Every log record has a stable, kebab-case event name from the [catalogue](../../libs/telemetry.core/src/log-events.ts), and each event has one fixed severity:** `error`, the operator must look at it; `warn`, degraded but handled; `info`, lifecycle events and outcomes; `debug`, never sent, because `beforeSendLog` drops anything below `info`.
- **Renaming an event breaks the operator's saved queries and alerts on it, so add a new name instead.**
- **Only [`logEvent`](../../libs/telemetry.cloudflare/src/log-event.ts) writes logs.** Logs are always on in Sentry's SDK 11, and every runtime's `beforeSendLog` drops `debug`. `logEvent` sends the record through `Sentry.logger` at the event's fixed severity, with the event name as `event.name`, the prose `message`, the given attributes and, for an `error`, its root cause as `exception.*` plus the wrapper types as `cup.exception.chain` (only Cup's own errors keep their message). It leaves out `undefined` attributes, which the SDK would send as an empty string. Without an active Sentry client, as in local development and tests, it sends nothing. It picks `Sentry.logger`'s function per severity from a map, because indexing the `logger` namespace import directly fails oxlint's `import/namespace` rule, which cannot check a computed member of a namespace.
- **Cup's own keys are dot-namespaced under `cup.`** in [`TELEMETRY_ATTRIBUTES`](../../libs/telemetry.core/src/telemetry-attributes.ts); use a semantic-convention name instead where one exists (OpenTelemetry's, for the log attributes such as `event.name` and `exception.type`). Each entry point puts the keys it knows on Sentry's isolation scope once; Sentry sends them as tags on errors and as attributes on spans and logs.
- **An audio segment's final failure is tagged `cup.conversion.failure_category=segment`**; a failed preparation is tagged with its conversion failure category instead.

### Log events

| Event                                    | Severity | Meaning                                                                                                                                                                            |
| ---------------------------------------- | -------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `content-limit`                          | warn     | A preparation failed because the narration exceeds the conversion's content ceiling.                                                                                               |
| `narration-language-fallback`            | warn     | Narration language detection fell back to the declared language or to none.                                                                                                        |
| `narration-language-unspeakable`         | warn     | The narration language is one the speech model cannot speak.                                                                                                                       |
| `cover-image-unavailable`                | warn     | The declared cover image could not be stored; the audiobook goes without one.                                                                                                      |
| `conversion-workflow-termination-failed` | warn     | A deleted conversion's Workflow instance that had not finished could not be terminated; it is tried once.                                                                          |
| `conversion-dispatch-failed`             | warn     | One pass of a conversion's preparation dispatch failed; its owner's alarm retries it.                                                                                              |
| `usage-projection-failed`                | warn     | The registry did not take an owner's usage projection; the owner's alarm pushes it again.                                                                                          |
| `conversion-deletion-cleanup-failed`     | warn     | One pass of a marked conversion's cleanup failed; the account alarm retries it.                                                                                                    |
| `account-deletion-identity-failed`       | warn     | One pass of an account deletion could not delete the Supabase identity; it is retried.                                                                                             |
| `account-deletion-erasure-failed`        | warn     | One pass of an account deletion could not erase the account; it is retried.                                                                                                        |
| `account-deletion-notice-undelivered`    | warn     | An account deletion notice ended `failed` or `expired` without being delivered.                                                                                                    |
| `narration-track-segment-mismatch`       | error    | A stored audio segment's size differs from the one its settled duration implies.                                                                                                   |
| `narration-document-mismatch`            | error    | A rendered narration document disagreed with the conversion's stored synchronization units, so the listener got the fallback document built from the units alone.                  |
| `narration-document-render-failure`      | error    | Loading, segmenting or presenting a narration document failed, so the listener got the fallback document built from the stored synchronization units alone.                        |
| `operator-mutation`                      | info     | The operator changed something through the Operator API.                                                                                                                           |
| `conversion-preparation-settled`         | info     | The owner recorded a preparation outcome: `ready`, `failed` with its failure category, or `insufficient-duration` for a prepared document that did not fit the available duration. |
| `audio-segment-settled`                  | info     | The owner settled an audio segment's audio, or released its reservation after a failure.                                                                                           |
| `conversion-synthesis-settled`           | info     | The last reserved audio segment of a conversion settled or was released.                                                                                                           |

### Telemetry keys

| Key                                      | Meaning                                                                                                                                                                                    |
| ---------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `cup.conversion.id`                      | The join key: every conversion-scoped error, span and log carries it.                                                                                                                      |
| `cup.synchronization_unit.id`            | A synchronization unit's ID, such as the first one a rendered narration document got wrong.                                                                                                |
| `cup.narration_document.mismatch_reason` | How a rendered narration document first disagreed with the stored units, one of the reasons `NarrationDocumentMismatch` in `@cup/narration-document-creation` lists.                       |
| `cup.owner.kind`                         | `account` or `grant`; a trial conversion's owner is its conversion grant.                                                                                                                  |
| `cup.component`                          | Which Worker entry point reported; `WorkerComponent` in `@cup/telemetry.cloudflare` lists them.                                                                                            |
| `cup.conversion.phase`                   | The conversion phase a conversion last started, such as `narration-content-selection`.                                                                                                     |
| `cup.conversion.outcome`                 | A preparation outcome: `ready`, `failed` or `insufficient-duration`.                                                                                                                       |
| `cup.conversion.elapsed_ms`              | Milliseconds from the conversion's creation until the event, retries included. On `conversion-synthesis-settled` without a failed segment, this is when the narration track came to exist. |
| `cup.conversion.failed_segments`         | How many of a conversion's audio segments were released after a failure.                                                                                                                   |
| `cup.audio_segment.outcome`              | How an audio segment settled: `settled` with audio, or `released` after a failure.                                                                                                         |
| `cup.audio_segment.reserved_ms`          | Milliseconds the segment held its duration reservation, until it settled or was released. More than its synthesis took: it includes the wait for dispatch, retries and rate-limit waits.   |
| `cup.audio_segment.attempts`             | The synthesis attempts of the segment's Workflow run, rate-limited ones included.                                                                                                          |
| `cup.conversion.stage`                   | `preparation` or `synthesis`: the stage a stuck conversion hangs in.                                                                                                                       |
| `cup.web_release`                        | A shell's web bundle, `web@<content hash of the entry chunk>`: the shell's release names its app version instead, so its JS and native events share one release.                           |
| `cup.renderer.cause`                     | Why a shell's Android WebView lost its renderer process: `crash` or `system-kill`.                                                                                                         |
| `cup.renderer.priority_at_exit`          | The Android WebView renderer's priority when it ended: `waived`, `bound` or `important`, by Android's `RenderProcessGoneDetail.rendererPriorityAtExit()`.                                  |
| `cup.app.state`                          | Whether a shell was `foreground` or `background` when its WebView lost its page.                                                                                                           |
| `cup.exception.chain`                    | The wrapper types of a logged error, outermost to innermost.                                                                                                                               |
| `cup.workflow_instance.id`               | A Cloudflare Workflow instance ID, such as a segment's; a preparation's is its conversion ID.                                                                                              |
| `cup.account_deletion.attempt_id`        | The account deletion attempt, an opaque ID distinct from the account ID.                                                                                                                   |
| `cup.account_deletion.pending`           | What an unfinished account deletion still waits for: `identity` (the Supabase identity), `account` (the account's fence or erasure), or `both`.                                            |
| `cup.account_deletion.notice_type`       | Which account deletion notice: `scheduled` or `completed`.                                                                                                                                 |
| `cup.account_deletion.notice_state`      | How a notice ended undelivered: `failed` or `expired`.                                                                                                                                     |
| `cup.narration.declared_html_lang`       | The page's `<html lang>`.                                                                                                                                                                  |
| `cup.narration.declared_og_locale`       | The page's `og:locale`.                                                                                                                                                                    |
| `cup.audio_segment.stored_byte_length`   | Absent when the segment is missing.                                                                                                                                                        |

The keys that follow `cup.narration.text_characters` in the catalogue are details of single log events; the log catalogue says which event uses which.

## Consequences

- A new log record needs a catalogue entry with its severity first; its name is then permanent.
- This record's tables must be kept in step with the catalogue when an event or key is added, since the source no longer describes them.

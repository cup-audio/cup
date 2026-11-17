# Observability operations

What the operator watches and checks in Sentry beyond captured errors: reports of stuck work, log records, conversion durations, the manual going-live checks, and how every release's stack traces resolve to source. The [observability overview](observability.md) holds the capture rule, privacy and alerts.

## Stuck checks

A stuck check reports work that should have finished long ago as one Sentry error event per case, with a fixed fingerprint per kind, so all cases of a kind land in one issue, which the [new-or-regressed alert](observability.md#alerts-and-monitors) emails. A flag stored with the work keeps later passes from reporting the same case again, and each event's message names the case's ID, so Sentry's deduplication does not drop the next case as a repeat. A case that settles after its report sends nothing more; the operator resolves the issue by hand.

- **[Stuck conversion](../GLOSSARY.md#stuck-conversion).** The account and conversion grant alarms report a conversion stuck in preparation or in synthesis, one issue per stage, tagged with the conversion and owner keys. Starting a stage again clears the flag, so a retry that hangs again is reported again. The thresholds are deliberately generous; tighten them once [conversion durations](#conversion-durations) are visible. The [conversion page](conversion.md#stuck-conversions) describes when a stage counts as stuck.
- **[Stuck conversion deletion](../GLOSSARY.md#stuck-conversion-deletion).** The account alarm reports a conversion still marked for deletion long after it was marked. The check measures age, not failed passes, because a cleanup that waits on an undrained artifact writer fails no pass; the per-pass [log records](#log-records) hold the root cause ([conversion deletion](conversion-deletion.md#invariants)).
- **[Stuck account deletion](../GLOSSARY.md#stuck-account-deletion).** The registry's [deletion coordinator](account-deletion.md#fencing-and-cleanup) reports an attempt still neither erased nor restored well after its recovery deadline, tagged with what is pending: the identity, the account or both. Its retries back off, so the report can arrive later than the threshold by the longest backoff. The Operator CLI's `overdue` listing uses the same threshold.

The [`@cup/telemetry.cloudflare` guide](../../libs/telemetry.cloudflare/README.md#use) names the reports; the code holds every threshold, tag and fingerprint, and no page repeats them.

## Log records

Every Worker log record goes through `logEvent` of [`@cup/telemetry.cloudflare`](../../libs/telemetry.cloudflare/README.md#use), which writes it to Sentry's logs; no Worker source writes to the console, and outside production a record goes nowhere. Each record has a stable event name from the [catalogue](../../libs/telemetry.core/src/log-events.ts), which states its one fixed severity and when it is written, its details as attributes with opaque IDs only, and for a logged error its root cause with the chain of wrapper types.

- **Severity says who acts**: `error` means the operator must look, `warn` degraded but handled, `info` lifecycle events and outcomes, and `debug` is never sent. An expected outcome is a warning, not an issue.
- **Per-pass warnings carry the root cause.** The cleanup warnings of [conversion deletion](conversion-deletion.md) and [account deletion](account-deletion.md#fencing-and-cleanup) name the conversion or account, so a stalled deletion can be investigated by its ID. Both owners' alarms also warn when a pass cannot dispatch a preparation or cannot push the owner's [usage projection](../GLOSSARY.md#usage-projection) to the registry; the next pass retries either.
- **A Workflow run logs inside a step.** The engine can replay a run, which runs the code between steps again and reuses each step's recorded result, so a record written in a step is written once.

## Conversion durations

The operator sees how long conversions take and how they end from three `info` [log records](#log-records) and from the Workflow step spans. The owning account or conversion grant Durable Object sends each record when it records the outcome, so a replayed outcome sends nothing; each carries the conversion ID, and the [outcome records](../../libs/telemetry.cloudflare/src/conversion-outcomes.ts) define their attributes.

- **Preparation settled**: the [conversion outcome](../GLOSSARY.md#conversion-outcome), with the time since the conversion was created, which after a retry includes the failed preparation and the wait before the retry.
- **Audio segment settled**: settled or released, with how long the segment held its duration reservation and, when its Workflow run recorded it, its synthesis attempts. The reservation time is more than the synthesis took: it includes the wait for dispatch, retries and rate-limit waits.
- **Synthesis settled**: sent with the segment record that leaves no segment of the conversion reserved, with the count of released segments and, when none failed, the time until the narration track existed. A retry that reserves segments again sends it again.

Sentry's Workflow wrapper makes every step a span named after the step, and each step's name starts with its [conversion phase](../GLOSSARY.md#conversion-phase), so a trace shows the time each phase takes. Cloudflare Workflows keys a step's stored result by its name: a deploy that renames a step makes an instance running at that moment run the step again.

## Going-live checks

These checks run once in production after the first deploy with Sentry, by the operator, and are not automated:

- `openai` spans carry no prompt or completion.
- Streamed traces work with `@sentry/capacitor` in the browser and both shells.
- Native app-start spans arrive on both platforms. **Unresolved:** the mobile E2E runs showed none on either platform, because the page starts the native SDK only after the first activity or view controller exists ([what the shells send](observability-clients.md#what-the-shells-send)). Whether to accept that or start the native SDK earlier is the operator's open question.
- Cocoa keeps or drops query strings in network breadcrumbs, and the organisation's masking rule covers what it keeps.
- An apply of the [Sentry Terraform root](../../terraform/README.md#sentry) against the Germany-region organisation creates every alert and monitor, and a second plan shows no changes.
- The organisation and `cup-worker` scrubbing rules work, the first plan's drift checks pass, and an event in Sentry shows the country only.
- On iOS, the [WebContent check](../../apps/mobile-app/README.md#ios-webcontent-check) passes.
- One forced error per project reaches production Sentry and emails the operator, and the uptime monitor shows the health check green.

## Build

The Worker's [Vite configuration](../../apps/cloudflare-worker/vite.config.ts) adds Sentry's Vite plugin for build-time instrumentation only. The Worker entry wraps its entry points itself, because the Worker integration tests run the entry through Wrangler's test harness, which bundles without Vite, and must run the same wrapping as production. Cloudflare receives no source maps.

## Release tracking

Every event names its release: the Worker version, the web app's `web@<hash>`, or a shell's `audio.cup.app@<version>+<build>` with the web release as a tag. Every Worker and web app stack trace resolves to Cup's source lines through source maps that are uploaded before the release goes live.

- **Debug IDs, not releases, match a stack trace to its source map.** The builds write a debug ID into every chunk and its map and move the maps out of what is served, deployed or packed into a shell ([`prepare-source-maps`](../../tooling/source-maps/README.md)). The IDs derive from file content, so the build stays deterministic and Turbo replays it on unchanged inputs.
- **The deploy uploads, then deploys.** The [deploy script](../production-configuration.md#deploy) uploads each project's maps and only then deploys the Worker; any failure aborts it. Events create their releases, so it makes no release API calls.
- **A native release uploads before the store upload.** The source maps of the packed web bundle, on iOS the archive's dSYMs and on Android R8's mapping file, are uploaded after a release build, and a failure blocks the store upload ([native release](../production-configuration.md#native-release)). Android has no native debug files to upload, since its build leaves out Sentry's NDK modules. Android release builds are shrunk by R8 since [#444](https://github.com/cup-audio/cup/issues/444); the build embeds its mapping file's ProGuard UUID, and the mapping file is uploaded under it, which matches the file to events.
- **The upload token stays out of every checkout.** It lives in the operator's home directory; the committed [`.sentryclirc`](../../.sentryclirc) names only the organisation and region, and `pnpm env:check` rejects a token in an environment file. No test calls Sentry.

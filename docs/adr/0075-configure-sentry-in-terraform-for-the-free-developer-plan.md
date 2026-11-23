---
status: accepted
---

# Configure Sentry in Terraform for the free Developer plan

[ADR 0030](0030-observe-production-with-sentrys-own-sdks-and-turn-cloudflares-observability-off.md) chose Sentry for production observability. Its organisation, projects, alerts and privacy settings are managed in `terraform/sentry`, introduced with Sentry reporting in [#422](https://github.com/cup-audio/cup/pull/422) (issue [#403](https://github.com/cup-audio/cup/issues/403)). The plan is Sentry's free Developer plan, so quotas and the provider's gaps shape the configuration. These decisions were recorded from code comments on 2026-11-23.

## Decision

Organisation and access ([main.tf](../../terraform/sentry/main.tf)):

- The operator creates the organisation in the Sentry UI (free Developer plan, Germany region) with the configured slug; Terraform only reads it, never imports it, so no plan can change or delete it.
- The organisation lives in Sentry's Germany region, so every API call goes to `de.sentry.io`.
- The provider reads `SENTRY_AUTH_TOKEN` from the environment. The privacy settings read the organisation and project through a variable that takes the same value ([terraform/README.md](../../terraform/README.md#sentry)).

Privacy ([privacy.tf](../../terraform/sentry/privacy.tf)):

- The provider cannot set the organisation's privacy settings or a project's Advanced Data Scrubbing rules, so these resources send them to Sentry's API whenever the committed JSON changes. Each PUT replaces every rule of its scope, so rules added in the UI are lost on the next change here; check blocks compare the live values in every plan, which catches such UI edits.
- "Show Generative AI Features" is off, so no member can send issue data to Sentry's AI features.
- The checks read `SENTRY_AUTH_TOKEN` from the environment Terraform runs in, so that token stays out of state. The token passed in `request_headers` is written to state; this is accepted, as state already holds the Sentry keys and is access-controlled.

Projects ([projects.tf](../../terraform/sentry/projects.tf)):

- `cup-worker` receives the Worker's events, `cup-app` those of the web app and both shells.
- Inbound filters drop junk at ingest, before it counts against the quota, including every legacy-browser subfilter Sentry has not deprecated (each filters that browser's old versions).
- Alert rules come from Terraform only, so Sentry's default "every new issue" rule stays off.
- Each project has a single key. Its DSN is public by design (a DSN only lets a client send events) and is compiled into [`@cup/telemetry.core`](../../libs/telemetry.core); replacing a key changes its DSN and silences every client that still sends to the old one.
- Spike protection sends Sentry's own notification, an email, when it starts dropping events. Sentry accepts one project per spike-protection action and only one target for its own notification.

Alerts ([alerts.tf](../../terraform/sentry/alerts.tf)):

- The alerts are the operator's only source of Sentry email: personal workflow notifications are off ([terraform/README.md](../../terraform/README.md#personal-notifications)). Each alert emails the team `cup`, so its members, at most once an hour per issue.
- The free plan holds 5k errors and 5M spans a month. A quota monitor fires at about a thirtieth of each, a day's share, so the operator learns before a quota runs out mid-month. Error and default (message) events both count against the error quota.
- Sentry creates default monitors with each project; the issue stream monitor tracks every new issue of the project, of every type, native crashes, ANRs and app hangs in `cup-app` included.
- The uptime check uses the free plan's single uptime monitor. The Worker drops the traces of these checks.
- One alert emails when a project gets a new issue or a resolved one comes back: server, client and native crash issues, the stuck checks' issues, and the issues of the project's uptime and metric monitors.
- Another emails when one conversion-failure issue, an error tagged with its failure category, is seen more than 5 times in an hour, so a burst stands out from a single failure. Only the Worker captures conversion failures. It has no trigger condition: every event of an issue is evaluated against its filters.

## Consequences

- Privacy settings changed in the Sentry UI show up as failed checks and are overwritten by the next change in Terraform.
- Rotating a project key needs a release of every client, since the DSN is compiled in.
- The alert set is sized to the free plan's quotas; a plan change means revisiting the monitors' thresholds.

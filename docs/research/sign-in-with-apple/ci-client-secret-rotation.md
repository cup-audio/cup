# Rotating Supabase's Apple client secret from a scheduled GitHub Actions workflow

Research date: 2026-11-23, for [issue #514](https://github.com/cup-audio/cup/issues/514) of the [Sign in with Apple map](https://github.com/cup-audio/cup/issues/465). The Supabase Terraform provider was read at tag `v1.11.0` ([`224237d3`][tfp]), the version [`terraform/production/main.tf`](../../../terraform/production/main.tf) pins, with its generated API client from `supabase/cli` `pkg/v1.2.3` ([`ae7642d5`][cli]) and `oapi-codegen/nullable` v1.2.0 ([nullable.go][nullable]). The Sentry provider was read at `jianyuan/terraform-provider-sentry` `v0.16.0` ([`7791f54e`][tfsentry]), the pinned version. The Management API's OpenAPI document was downloaded from `https://api.supabase.com/api/v1-json` on the research date. Supabase, GitHub, Google, zizmor and Sentry documentation was read on the research date. The repository's GitHub settings were read through the REST API on the research date. Nothing was run against Supabase, Apple or Sentry: every behaviour below comes from source, specification and documentation, not a probe.

## Question

How can a scheduled GitHub Actions workflow in the public `cup-audio/cup` repository sign Supabase's Apple client secret and write it to the production Supabase project with the least access, while Terraform keeps managing the rest of Supabase's auth settings? Covered: whether the Management API can update only `external_apple_secret` and with which credential; what the Supabase provider does with an auth key left out of the `supabase_settings` JSON; what running `terraform apply` in the workflow would take instead; how to hold the `.p8` key and the Supabase credential in GitHub Actions; and how the workflow reports success and failure.

## Summary

The Management API's `PATCH /v1/projects/{ref}/config/auth` takes a body with no required fields, so a request carrying only `external_apple_secret` changes only that key. The narrowest credential is a scoped personal access token (PAT) limited to the one production project, but the endpoint requires two permissions, **Auth Config (Read-write)** and **Project Settings (Read-write)**, and the second also allows deleting, pausing, restoring and updating the project. A leaked token can therefore change any auth setting, including the redirect allow-list, and delete the production project. The token expires after at most one year, so it is a second expiring credential. OAuth apps offer nothing narrower for an unattended job, and Supabase has no federation with GitHub's OIDC tokens. Terraform coexists cleanly: provider 1.11.0 refreshes and diffs only the keys written in the `auth` JSON and omits unset keys from its `PATCH`, so leaving `external_apple_secret` out means Terraform neither shows drift nor clears the value. Running `terraform apply` in the workflow would instead need Google Workload Identity Federation for the state bucket, every production credential (Supabase, Cloudflare, Google), every root variable, and third-party actions that the repository's Actions policy does not allow today. GitHub keeps environment secrets away from jobs that don't reference the environment and from fork pull requests, and an environment limited to `main` rejects jobs from other branches. A Sentry cron monitor, declared with `sentry_cron_monitor` in [`terraform/sentry`](../../../terraform/sentry), checks in through the project's public DSN key, so it needs no secret, and it catches the runs GitHub never starts. The recommendation at the end favours the Management API with a scoped PAT in a `main`-only environment and three secrets.

## The Management API endpoint

The OpenAPI document defines `GET` (`v1-get-auth-service-config`, OAuth scope `auth:read`) and `PATCH` (`v1-update-auth-service-config`, OAuth scope `auth:write`) on `/v1/projects/{ref}/config/auth`. The `PATCH` body is `UpdateAuthConfigBody`, an object of 236 properties with no `required` list, each nullable; the Apple keys are `external_apple_enabled`, `external_apple_client_id`, `external_apple_additional_client_ids`, `external_apple_secret` and `external_apple_email_optional` ([OpenAPI document][mgmt-api]). A body of `{"external_apple_secret": "<JWT>"}` is therefore valid. That the server leaves every other key untouched is what a body without required fields implies; the document does not state the merge semantics in prose. Indirect evidence: Cup's own Terraform has always sent only seven keys, and the other 229 settings were not reset ([`supabase.tf`](../../../terraform/production/supabase.tf), [Terraform README](../../../terraform/README.md#application-infrastructure-and-adoption)).

The `GET` response returns `external_apple_secret` as a hash rather than the value ([provider docs][tfp-auth-doc]). The workflow can read the hash before and after its `PATCH` and fail when it did not change. The hash algorithm is undocumented, so the workflow cannot recompute it from the JWT it signed.

The Apple client secret itself is an ES256 JWT with header `kid` and claims `iss` (Team ID), `iat`, `exp`, `aud` `https://appleid.apple.com` and `sub` (the Services ID); "It’s an error to request an expiration time more than 15777000 seconds (six months) in the future" ([Apple: Creating a client secret][apple-secret]). The map's earlier research covers the claims and why only the web flow uses this secret ([Supabase Apple provider research][sibling-supabase], [Apple token exchange research][sibling-tokens]).

## Which credential can call it

### Scoped personal access tokens

Supabase now offers two kinds of PAT. A full-access token, marked **Legacy** in the dashboard, "carries every permission on every organization and project you belong to", including ones created later. A scoped token, the dashboard's default since general availability on 2026-10-06, starts with `sbp_fc` and is limited to chosen organizations or projects and to Read or Read-write per permission. Its access cannot be edited after creation, it never exceeds its creator's role, and every request is checked against that role ([Supabase: Personal access tokens][sb-pat], [changelog][sb-pat-ga]). Expiry is a preset or a custom date "up to one year out" ([changelog][sb-pat-ga]). Supabase recommends "scoping every token, especially tokens for AI agents, automation scripts, and CI environments" ([Supabase: Access tokens][sb-tokens]).

The permission table lists "Update auth service config" under both **Auth Config (Read-write)** and **Project Settings (Read-write)**, with the footnote that it requires both ([Supabase: Personal access tokens][sb-pat]). The OpenAPI document agrees: its `x-fga-permissions` for the `PATCH` are `auth_config_write` with `project_admin_write` ([OpenAPI document][mgmt-api]). So the minimal token for the workflow is a scoped PAT on the one project `evwjipxgacwotgbmqtla` with exactly those two permissions; Read is implied by Read-write, and no other permission is needed.

What that token can do if it leaks, from the same permission table:

- **Auth Config (Read-write):** every auth setting, including `site_url` and `uri_allow_list` (an attacker's host on the allow-list can receive OAuth and magic-link redirects), the Google and Apple provider settings, SMTP, and auth hooks; also SSO providers and third-party auth integrations.
- **Project Settings (Read-write):** "Delete a project", "Pause a project", "Restore a project", "Restart a project", "Update a project", "Update JIT access config", "Update pgsodium config", private link associations, and, together with **Database (Read-write)**, which the token lacks, upgrading Postgres.
- **Not granted:** database access, API keys and their secrets, Edge Functions and their secrets, storage, other projects and the organization. Auth secrets come back hashed, so the token cannot read the Google or Apple secret.

Terraform's `prevent_destroy` on `supabase_project.production` guards only Terraform; it does not stop an API call. The sources are silent on any Supabase-side deletion protection. Supabase's docs do not describe an API to read a token's expiry, so the expiry date has to be recorded when the token is created.

The standard rate limit is 120 requests a minute per user, shared by all of that user's PATs ([Supabase: Management API][sb-api-intro]); a monthly job is far below it.

### OAuth apps

An OAuth app is created in an organization's settings and its scopes are fixed at creation; tokens "are short-lived and tied to specific scopes" ([Supabase: Management API][sb-api-intro], [Supabase: Build a Supabase integration][sb-oauth]). The token endpoint accepts `authorization_code`, `refresh_token` and `urn:ietf:params:oauth:grant-type:jwt-bearer`, and its response has a `project_refs` list ([OpenAPI document][mgmt-api]). An unattended job would need an interactive authorization once and then a stored refresh token; Supabase's docs are silent on refresh token lifetime and rotation, and if refresh tokens rotate, the workflow would also need permission to write the new one back into GitHub's secrets. The scope `auth:write` maps to the same `auth_config_write` and `project_admin_write` checks, so an OAuth token would not be narrower than the scoped PAT. The `jwt-bearer` grant takes an "IDJAG assertion JWT", a beta "available on Team and Enterprise plans only", and is not GitHub's OIDC token ([OpenAPI document][mgmt-api]). No Supabase source describes accepting GitHub Actions OIDC tokens; the access token pages mention neither OIDC nor workload identity ([Supabase: Access tokens][sb-tokens], [changelog][sb-pat-ga]). For this job a scoped PAT is the only practical credential.

## Terraform alongside the workflow

`supabase_settings.auth` is a `jsontypes.Normalized` string. The provider handles it like this at `v1.11.0` ([`settings_resource.go`][tfp-settings]):

- **Read** fetches the full config, converts it to `UpdateAuthConfigBody`, copies the write-only secrets (including `ExternalAppleSecret`) from prior state over the API's hashes in `copySensitiveFields`, and then calls `parseConfig(state.Auth, resultBody)` ([L392-L425][tfp-read]). `parseConfig` unmarshals the state JSON into a map and `pickConfig` overwrites only the keys already in that map ([L617-L683][tfp-parse]). Keys the configuration never wrote never enter state, so they cannot show drift.
- **Plan** compares that refreshed JSON with the configuration's JSON. With `external_apple_secret` absent from both, the secret plays no part in the diff.
- **Update** runs only when the planned `auth` differs from state ("Only update settings that are present in the plan and have actually changed", [L281-L293][tfp-update]). `updateAuthConfig` unmarshals the planned JSON into `UpdateAuthConfigBody` and sends it as the `PATCH` body ([L427-L453][tfp-update-auth]). The field is `nullable.Nullable[string]` tagged `json:"external_apple_secret,omitempty"` ([`types.gen.go#L3809`][cli-field]), and an unset `Nullable` is a nil map, which `omitempty` drops ([nullable.go][nullable]). The request therefore carries no `external_apple_secret`, and the server keeps the workflow's value.

So if [`supabase.tf`](../../../terraform/production/supabase.tf) leaves `external_apple_secret` out, Terraform leaves the value alone and never shows it as drift. The same mechanism already hides out-of-band changes to `external_google_secret`, which Terraform does set: the provider's own warning is that hashed fields are preserved from state and "out-of-band changes will not appear in `terraform plan`" ([provider docs][tfp-auth-doc]).

Three consequences for the configuration:

- **Keep the key out for good.** If `external_apple_secret` is ever added to the JSON, every apply that changes `auth` sends the stored value and overwrites the workflow's newer secret. A comment in `supabase.tf` should say why the key is missing.
- **Apple's other keys can stay in Terraform.** `external_apple_enabled`, `external_apple_client_id`, `external_apple_additional_client_ids` and `external_apple_email_optional` are not hashed and are refreshed normally; the provider keeps the split between the client ID and the additional IDs to avoid drift (`preserveAppleAdditionalClientIDs`, [L802-L814][tfp-preserve]).
- **First run order.** Whether the API accepts `external_apple_enabled = true` with no secret yet is undocumented. Native sign-in does not use the secret, but web sign-in fails without it. Running the workflow by hand (`workflow_dispatch`) before or right after the apply that enables Apple avoids a window with no secret.

`lifecycle { ignore_changes = [auth] }` is not needed and would stop Terraform from managing the other auth settings.

## The alternative: `terraform apply` in the workflow

Putting the secret in Terraform means a new sensitive variable, the JWT in remote state on every rotation, and an apply from CI. That apply would need:

- **State access.** The GCS backend `cup-infrastructure-646301813623-tfstate` (prefix `production`) through Google Workload Identity Federation. `google-github-actions/auth` recommends direct federation, warns to "Always add an Attribute Condition to restrict entry into the Workload Identity Pool", needs `id-token: write`, and yields tokens of at most 10 minutes for direct federation or one hour through a service account ([google-github-actions/auth][gha-auth]). The pool, provider, condition and bucket IAM would be new resources, probably in the bootstrap root. The state holds the database password and the Google client secret in plain text ([Terraform README](../../../terraform/README.md#application-infrastructure-and-adoption)), so read access to it alone exposes both.
- **Every provider's credentials.** Terraform refreshes every resource unless `-target` limits it: the Supabase token (project-level permissions for `supabase_project` as well as auth), the Cloudflare API token with DNS, Email Routing, R2, Access and AI Gateway permissions, and Google credentials able to read the project, its services, the uploader service account and its IAM bindings ([Terraform README](../../../terraform/README.md#cloudflare), [Google Play uploader](../../../terraform/README.md#google-play-uploader)). Whether `-target=supabase_settings.production` would let the job skip the Cloudflare and Google credentials was not checked.
- **Every root variable.** `supabase_database_password`, `google_web_client_id`, `google_web_client_secret` and `support_email_destination` have no defaults, so each becomes a GitHub secret too.
- **Third-party actions.** The repository allows only GitHub-owned actions and requires SHA pinning (`allowed_actions: selected`, `github_owned_allowed: true`, `patterns_allowed: []`, `sha_pinning_required: true`, read through the REST API on the research date). `google-github-actions/auth` and `hashicorp/setup-terraform` are not GitHub-owned, so the policy would have to change, or the job would install Terraform and exchange the OIDC token by hand.

An unattended apply also applies whatever else `main` holds. The Terraform README asks that plans be reviewed before applying, warns that a checkout lacking resources held in state proposes destroying them, and documents applies that must run in two targeted steps ([Terraform README](../../../terraform/README.md#local-use), [Cloudflare](../../../terraform/README.md#cloudflare), [Support mail](../../../terraform/README.md#support-mail)). A scheduled apply would apply unreviewed plans with credentials for all of production; a leak would expose all of them.

## Holding the key and the token in GitHub Actions

Repository facts on the research date: public, default branch `main`, no branch protection or rulesets on `main`, one collaborator (`patricktree`, admin), no environments, no workflows, `default_workflow_permissions: read`, fork pull requests from first-time contributors need approval, and the actions policy above.

- **Environment secrets.** "Secrets stored in an environment are only available to workflow jobs that reference the environment." On GitHub Free, environment secrets exist only in public repositories, which Cup is ([GitHub: Deployments and environments][gh-env]). Store the `.p8` key and the PAT as secrets of one environment, for example `apple-client-secret-rotation`, never as repository secrets. "Any user with write access to your repository has read access to all secrets configured in your repository" ([GitHub: Secure use][gh-secure]).
- **Deployment branch rule.** "Selected branches and tags" with the single pattern `main` admits only jobs running on `main` ([GitHub: Deployments and environments][gh-env]). "Protected branches only" would need branch protection, which `main` doesn't have. GitHub's page describes this rule as controlling deployments; that it also withholds the environment's secrets from a rejected job follows from the job not starting, not from an explicit sentence. With the rule, a `workflow_dispatch` against another branch, which GitHub allows once a workflow has run ([GitHub: Events][gh-events]), gets no secrets. By default administrators can bypass protection rules; the environment can be set to disallow bypassing ([GitHub: Deployments and environments][gh-env]).
- **Required reviewers.** These are available for public repositories on Free, but "users who initiate a deployment cannot approve the deployment job" ([GitHub: Deployments and environments][gh-env]); with one person, a scheduled job would need approval on every run, which defeats unattended rotation. Leave them off; the branch rule is the gate.
- **Scheduled runs.** "Scheduled workflows run on the latest commit on the default branch", may be delayed under load, and "some queued jobs may be dropped"; "In a public repository, scheduled workflows are automatically disabled when no repository activity has occurred in 60 days"; notifications go to "the user who last modified the cron syntax in the workflow file" ([GitHub: Events][gh-events]). A schedule can therefore silently stop, which is why the Sentry monitor below matters.
- **Fork pull requests.** "With the exception of `GITHUB_TOKEN`, secrets are not passed to the runner when a workflow is triggered from a forked repository", and `GITHUB_TOKEN` is read-only there ([GitHub: Events][gh-events]). The rotation workflow should not have a `pull_request` trigger at all: `schedule` and `workflow_dispatch` only.
- **`pull_request_target` and `workflow_run`.** These run in the base repository's context with its secrets; GitHub says to avoid them with untrusted code ([GitHub: Secure use][gh-secure]), and zizmor's `dangerous-triggers` flags them ([zizmor audits][zizmor]). A `pull_request_target` run's ref is the base branch, so a `main`-only environment would not stop it; no workflow in the repository may use either trigger with this environment.
- **Who can still read the secrets.** Anyone who can push to `main` can change the workflow to print them. Today that is the operator's account, which agent sessions also use, so a workflow change on `main` is the real boundary. Code review of any change to the workflow file is the remaining control.
- **`permissions:`.** zizmor recommends `permissions: {}` at the workflow level ([zizmor audits][zizmor]); the job needs no `GITHUB_TOKEN` scope and, on this path, no `id-token`. If it checks out the repository for a script, `actions/checkout` with `persist-credentials: false` satisfies `artipacked`, and `contents: read` is the only permission it needs.
- **Pinning.** zizmor's `unpinned-uses` requires every action, `actions/*` included since v1.20.0, to be pinned by SHA ([zizmor audits][zizmor]), and the repository enforces SHA pinning. GitHub now recommends a workflow dependency lockfile, which "supersedes SHA pinning for repositories that adopt it" ([GitHub: Secure use][gh-secure]); whether it is generally available was not checked. On the Management API path the job can use `node` and `curl`, which GitHub's Ubuntu runner provides, plus at most `actions/checkout`.
- **Masking.** The signed JWT is derived from a secret, so the runner does not redact it automatically; GitHub says to mask such values with `::add-mask::` ([GitHub: Secure use][gh-secure]). Keep the `.p8` PEM as one secret, not inside a JSON blob, since the runner redacts only exact secret values (zizmor's `unredacted-secrets`, [GitHub: Secure use][gh-secure]). Pass secrets to `run:` steps through `env:` rather than `${{ }}` expansion in the script (`template-injection`). The script should never echo the request body.
- **zizmor in the gate.** The review gate already runs `uvx zizmor@1.32.0` over the whole repository ([`package.json`](../../../package.json), [AGENTS.md](../../../AGENTS.md#validation-gates)), so the new workflow is audited before review. `secrets-outside-env`, which flags secrets used by a job without an environment, runs only in the auditor persona ([zizmor audits][zizmor]); the default run won't report it.
- **Concurrency.** A `concurrency` group keeps a manual run and a scheduled run from writing at once (zizmor's pedantic `concurrency-limits`).

The `.p8` key in GitHub is a second copy: the Worker already holds the same key to sign its own secrets ([issue #469](https://github.com/cup-audio/cup/issues/469)). A leaked key lets its holder sign client secrets for Cup's Services ID and bundle ID, so it can exchange or revoke Apple tokens with any authorization code or refresh token it also obtains; it cannot mint Apple identity tokens, which Apple signs. Revoking a leaked key in the Apple Developer console breaks the Worker's exchange and revocation until both copies are replaced.

## Reporting

- **GitHub's failure email** reaches the user who last modified the cron line ([GitHub: Events][gh-events]), subject to that user's notification settings. It fires only for runs that start and fail. It says nothing when the schedule is disabled after 60 days of inactivity, a scheduled run is dropped, or the workflow file is deleted.
- **A Sentry cron monitor** catches those cases: Sentry opens an issue when a check-in is missed or reports an error. Provider `jianyuan/sentry` 0.16.0 has `sentry_cron_monitor` with `schedule` (crontab or interval), `checkin_margin_minutes`, `max_runtime_minutes`, `failure_issue_threshold`, `recovery_threshold`, `timezone` and `owner` ([cron_monitor docs][tfsentry-cron]). It is a monitor of Sentry's current model, which `sentry_alert` takes in `monitor_ids` ([alert docs][tfsentry-alert]), so adding it to `sentry_alert.new_or_regressed_issue` for `cup-worker` in [`alerts.tf`](../../../terraform/sentry/alerts.tf) emails the team like the uptime monitor does. "All Sentry plans include one cron monitor and one uptime monitor" ([Sentry pricing][sentry-pricing]), and Cup uses no cron monitor yet.
- **Check-ins need no secret.** The workflow calls `https://o<orgId>.ingest.<region>.sentry.io/api/<project-id>/cron/<monitor_slug>/<public-key>/` with `status=in_progress`, then `ok` or `error` ([Sentry: HTTP check-ins][sentry-http]). The public key is the project DSN's, which Cup already treats as public ([Terraform README](../../../terraform/README.md#dsn-handover)). Anyone who knows it could send a false `ok`; that would hide a failure, not cause one. Check-ins are limited to six a minute per monitor environment ([Sentry: HTTP check-ins][sentry-http]).
- **Open: the monitor slug.** The check-in URL needs the monitor's slug, but `sentry_cron_monitor` has no slug attribute; it exposes only `id` ([cron_monitor docs][tfsentry-cron]), and the sources are silent on how Sentry derives the slug for a monitor created through this API. The operator would read it from the Sentry UI after the apply, and the implementation should confirm it. The alternative, creating the monitor by `monitor_config` upsert in the first check-in ([Sentry: HTTP check-ins][sentry-http]), would put the monitor outside Terraform.
- **Margins.** GitHub can delay scheduled runs, so the grace period (`checkin_margin_minutes`) should be generous, for example a few hours for a monthly job; `failure_issue_threshold = 1` reports the first missed or failed run.

A successful `PATCH` and a changed secret hash show that Supabase stored a new value, not that Apple accepts it. Only a web Apple sign-in proves that; the sources describe no cheaper health check.

## Where sources are silent

- Whether the auth `PATCH` merges or replaces keys is implied by the schema, not documented in prose.
- The hash algorithm of `external_apple_secret` in `GET` responses.
- Whether Supabase rejects `external_apple_enabled = true` without a secret.
- An API to read a scoped PAT's expiry, and any deletion protection for projects outside Terraform.
- OAuth app refresh token lifetime and rotation; no Supabase support for GitHub OIDC.
- Whether GitHub withholds environment secrets from a job rejected by a deployment branch rule is implied by the job not starting rather than stated outright.
- How Sentry derives a cron monitor's slug when it is created through `sentry_cron_monitor`.
- Whether `terraform apply -target` would work without the Cloudflare and Google credentials.

## Recommendation

These are inputs for the operator's decision, not the decision.

**Path: the Management API with a scoped PAT; Terraform keeps every other auth key.** The workflow signs the JWT with `exp` just under 15,777,000 seconds ahead, reads the secret hash, sends `PATCH /v1/projects/evwjipxgacwotgbmqtla/config/auth` with only `external_apple_secret`, reads the hash again, and checks in with Sentry. `supabase.tf` gains the four non-secret Apple keys and a comment saying why `external_apple_secret` stays out. Triggers: `schedule` (monthly, say, so five consecutive failures still leave a valid secret) and `workflow_dispatch` for the first run and recovery. The job uses one environment limited to `main` with administrator bypass disabled, `permissions: {}`, a `concurrency` group, no third-party actions, the JWT masked, and the review gate's zizmor run, plus one auditor-persona run when the workflow is added.

**Minimal secret set: two environment secrets.**

- `APPLE_SIGN_IN_PRIVATE_KEY`: the `.p8` PEM of key `6Y358M9M9A`.
- `SUPABASE_ACCESS_TOKEN`: a scoped PAT on project `evwjipxgacwotgbmqtla` only, with Auth Config (Read-write) and Project Settings (Read-write), expiring in at most a year.

Everything else is public configuration, kept in the workflow file or as variables: the Sentry DSN public key, project ID, organization ID and monitor slug, and the Team ID, key ID and Services ID, which the repository's docs and issues already name.

**Trade-offs:**

- **For:** one call, two secrets, no state access, no third-party actions, no change to the Actions policy, and the rest of production stays out of CI.
- **Against:** the PAT is broader than the job. Project Settings (Read-write) can delete or pause the production project, and Auth Config (Read-write) can redirect sign-ins. Supabase offers nothing narrower today. Its one-year expiry is a second date to track: when it lapses, the workflow fails with a 401, and the Sentry issue for that error is the reminder. The PAT is also tied to the operator's Supabase account and role.
- **Against:** Terraform can no longer show whether the Apple secret is current. Sentry's monitor and the hash check are the only signals, and the Google secret already has the same blind spot.
- **The `terraform apply` path** would make Terraform the only writer and keep the secret's history in state, but it would put every production credential and the state bucket within reach of a scheduled job, need Workload Identity Federation and third-party actions, and apply unreviewed plans. It does not fit the least-privilege goal.

## Sources

- Supabase: [Management API introduction][sb-api-intro], [Personal access tokens][sb-pat], [Access tokens][sb-tokens], [Scoped PATs GA changelog][sb-pat-ga], [Build a Supabase integration][sb-oauth], [Management API OpenAPI document][mgmt-api].
- Supabase Terraform provider `v1.11.0`: [`settings_resource.go`][tfp-settings], [`supabase_settings` docs][tfp-auth-doc]; generated client [`types.gen.go`][cli-field]; [`oapi-codegen/nullable` v1.2.0][nullable].
- Apple: [Creating a client secret][apple-secret].
- GitHub: [Events that trigger workflows][gh-events], [Deployments and environments][gh-env], [Secure use reference][gh-secure].
- Google: [`google-github-actions/auth`][gha-auth].
- zizmor: [Audit rules][zizmor].
- Sentry: [HTTP check-ins][sentry-http], [Pricing][sentry-pricing], provider `jianyuan/sentry` `v0.16.0` [`sentry_cron_monitor`][tfsentry-cron], [`sentry_alert`][tfsentry-alert].
- Map research: [Supabase Apple provider][sibling-supabase], [Apple token exchange and revocation][sibling-tokens].
- Cup: [`supabase.tf`](../../../terraform/production/supabase.tf), [`main.tf`](../../../terraform/production/main.tf), [Terraform README](../../../terraform/README.md), [`terraform/sentry`](../../../terraform/sentry), [ADR 0020](../../adr/0020-validate-in-three-local-gates-that-trust-the-turbo-cache.md), [ADR 0033](../../adr/0033-ship-android-test-builds-from-the-operators-mac-to-google-plays-internal-testing-track.md).

[tfp]: https://github.com/supabase/terraform-provider-supabase/tree/224237d3c432663bd265137c10b4e583f60ea0f7
[tfp-settings]: https://github.com/supabase/terraform-provider-supabase/blob/224237d3c432663bd265137c10b4e583f60ea0f7/internal/provider/settings_resource.go
[tfp-read]: https://github.com/supabase/terraform-provider-supabase/blob/224237d3c432663bd265137c10b4e583f60ea0f7/internal/provider/settings_resource.go#L392-L425
[tfp-parse]: https://github.com/supabase/terraform-provider-supabase/blob/224237d3c432663bd265137c10b4e583f60ea0f7/internal/provider/settings_resource.go#L617-L683
[tfp-update]: https://github.com/supabase/terraform-provider-supabase/blob/224237d3c432663bd265137c10b4e583f60ea0f7/internal/provider/settings_resource.go#L281-L293
[tfp-update-auth]: https://github.com/supabase/terraform-provider-supabase/blob/224237d3c432663bd265137c10b4e583f60ea0f7/internal/provider/settings_resource.go#L427-L453
[tfp-preserve]: https://github.com/supabase/terraform-provider-supabase/blob/224237d3c432663bd265137c10b4e583f60ea0f7/internal/provider/settings_resource.go#L802-L814
[tfp-auth-doc]: https://github.com/supabase/terraform-provider-supabase/blob/224237d3c432663bd265137c10b4e583f60ea0f7/internal/provider/settings_resource.go#L112-L123
[cli]: https://github.com/supabase/cli/tree/ae7642d5089c9752b543681010f1ef4c434794be
[cli-field]: https://github.com/supabase/cli/blob/ae7642d5089c9752b543681010f1ef4c434794be/pkg/api/types.gen.go#L3809
[nullable]: https://github.com/oapi-codegen/nullable/blob/v1.2.0/nullable.go
[mgmt-api]: https://api.supabase.com/api/v1-json
[sb-api-intro]: https://supabase.com/docs/reference/api/introduction
[sb-pat]: https://supabase.com/docs/guides/platform/personal-access-tokens
[sb-tokens]: https://supabase.com/docs/guides/platform/access-tokens
[sb-pat-ga]: https://supabase.com/changelog/scoped-personal-access-tokens-ga
[sb-oauth]: https://supabase.com/docs/guides/integrations/build-a-supabase-integration
[apple-secret]: https://developer.apple.com/documentation/accountorganizationaldatasharing/creating-a-client-secret
[gh-events]: https://docs.github.com/en/actions/reference/workflows-and-actions/events-that-trigger-workflows
[gh-env]: https://docs.github.com/en/actions/reference/workflows-and-actions/deployments-and-environments
[gh-secure]: https://docs.github.com/en/actions/reference/security/secure-use
[gha-auth]: https://github.com/google-github-actions/auth/blob/main/README.md
[zizmor]: https://docs.zizmor.sh/audits/
[sentry-http]: https://docs.sentry.io/product/crons/getting-started/http/
[sentry-pricing]: https://docs.sentry.io/pricing/
[tfsentry]: https://github.com/jianyuan/terraform-provider-sentry/tree/7791f54e3794234bad22c5b50b0426b5cfce94db
[tfsentry-cron]: https://github.com/jianyuan/terraform-provider-sentry/blob/7791f54e3794234bad22c5b50b0426b5cfce94db/docs/resources/cron_monitor.md
[tfsentry-alert]: https://github.com/jianyuan/terraform-provider-sentry/blob/7791f54e3794234bad22c5b50b0426b5cfce94db/docs/resources/alert.md
[sibling-supabase]: https://github.com/cup-audio/cup/blob/research/sign-in-with-apple-supabase/docs/research/sign-in-with-apple/supabase-apple-provider.md
[sibling-tokens]: https://github.com/cup-audio/cup/blob/research/sign-in-with-apple-tokens/docs/research/sign-in-with-apple/apple-token-exchange-and-revocation.md

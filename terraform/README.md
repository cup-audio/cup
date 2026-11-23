# Terraform infrastructure

Run each root independently from the repository root.

| Root                                               | Managed resources                                                                                                                                                                               | GCS state prefix    |
| -------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------- |
| [bootstrap](bootstrap/main.tf)                     | Infrastructure project, state bucket, and the [GitHub Actions identity](#github-actions-identity) of the Apple client secret rotation                                                           | bootstrap           |
| [production](production/main.tf)                   | Existing cup-production GCP project, its APIs and the Google Play uploader service account; Terraform-created Supabase project; Cloudflare R2 bucket, DNS, Email Routing, Access and AI Gateway | production          |
| [apple-client-secret](apple-client-secret/main.tf) | Supabase's Apple client secret only, applied by the [rotation workflow](#apple-client-secret)                                                                                                   | apple-client-secret |
| [sentry](sentry/main.tf)                           | Sentry team, projects, keys, inbound filters, spike protection, privacy settings, alerts and monitors                                                                                           | sentry              |

All roots use `cup-infrastructure-646301813623-tfstate` in Frankfurt (`europe-west3`).
The bootstrap project uses Cup Billing (`01EF28-40C66E-325909`).
Application teardown must never include the bootstrap root.

## Local use

Use Terraform 1.10 or newer, below 2.0, and Google Application Default Credentials with access to the bucket and managed resources.
Authenticate if needed:

```sh
gcloud auth application-default login
```

Initialize and review the relevant root:

```sh
terraform -chdir=terraform/bootstrap init
terraform -chdir=terraform/bootstrap plan
terraform -chdir=terraform/production init
node --env-file=terraform/.env.local --input-type=module -e 'import cp from "node:child_process"; process.exitCode = cp.spawnSync("terraform", ["-chdir=terraform/production", "plan"], {stdio: "inherit"}).status;'
```

Review a plan before applying it.
Keep provider lock files in version control; local Terraform directories, state, variable files and `.tfplan` files are ignored because they may contain credentials.
Use the `.tfplan` extension if saving plans.

## Bootstrap protection and adoption

The project and bucket were created before this configuration and imported on 2026-09-22.
Do not repeat these imports for the existing backend:

```sh
terraform -chdir=terraform/bootstrap import google_project.infrastructure cup-infrastructure
terraform -chdir=terraform/bootstrap import google_storage_bucket.terraform_state cup-infrastructure-646301813623-tfstate
```

Both resources have `prevent_destroy`; the project additionally uses the provider's `PREVENT` deletion policy and the bucket disallows forced deletion.
These Terraform protections depend on retaining the resource configuration and do not prevent deletion through the Google console or other tools.
The bucket has uniform IAM, enforced public access prevention, object versioning and seven-day soft deletion.
The GCS backend uses its native state locking; leave locking enabled.
Bootstrap imports successfully wrote remote state with default locking enabled, and the subsequent plan reported no changes.
A concurrent lock-contention test has not been performed.

## Application infrastructure and adoption

The production backend manages the existing cup-production GCP project, imported on 2026-09-22 with deletion protection.
The project currently has no organization parent and billing is disabled; adoption preserves those settings.
Terraform created the Supabase project named cup-production in Ireland (eu-west-1), with a five-minute JWT lifetime. Its site URL is <https://cup.audio/app>, applied on 2026-10-12 together with a replacement Google OAuth client secret. This project was created through Terraform; the Google Cloud projects and state bucket were adopted by importing existing resources.
The Google OAuth client remains outside Terraform state; Cloudflare resources are covered under [Cloudflare](#cloudflare). Terraform configures Supabase to use the manually created Google OAuth client. Application deployment and Cloudflare Worker secrets are managed separately with Wrangler; see [production configuration](../docs/production-configuration.md).
Supabase uses a management access token.
Keep secrets outside committed files.
Select and lock application providers when adding their resources, then review imports and plans before applying configuration changes.
Creating or changing the Google consumer OAuth client remains a manual operation.

Store infrastructure credentials in the ignored local file `terraform/.env.local`: `SUPABASE_ACCESS_TOKEN` for a Supabase personal access token and `CLOUDFLARE_API_TOKEN` (see [Cloudflare](#cloudflare)).
This file is not automatically loaded by Terraform; credentials must be passed to the provider process when continuing adoption.
The Worker keeps its existing sending-only key.

The generated Supabase database password is stored as `TF_VAR_supabase_database_password` in the same local credentials file and as a sensitive value in protected remote state.
Retain it for subsequent plans; sensitive marking suppresses terminal output but does not remove the value from state.
On 2026-10-02, the operator confirmed that the manually created Supabase project `oiehcntuiazvunyzngmi` had been deleted. It was never managed by this Terraform configuration; use the replacement project below.

The Terraform-created project reference is `evwjipxgacwotgbmqtla`, with URL <https://evwjipxgacwotgbmqtla.supabase.co>.
Configure social providers against callback <https://evwjipxgacwotgbmqtla.supabase.co/auth/v1/callback>. On 2026-10-01, the replacement management token successfully authenticated, the operator-verified Google OAuth secret was applied, and the subsequent production plan reported no changes. The bootstrap plan also reported no changes. These checks do not establish end-to-end sign-in or application deployment; the [Google sign-in configuration](#google-sign-in-configuration) records the later web sign-in check.

## Resend domain

`cup.audio` is the Resend domain the [deletion notices](../libs/registry/src/providers/resend-email.ts) are sent from (c9699e52-23e4-4fa7-a86c-b1a21f3e0d16). Manage it in the Resend dashboard. Keep it in Ireland (eu-west-1) with open and click tracking disabled and opportunistic TLS; the custom return path is left unspecified. Its DNS records are declared under [Cloudflare](#cloudflare). That the Worker's sending-only key may send from the domain is unverified.

Terraform managed the domain from 2026-10-12 through the community provider y0n0zawa/resend 1.0.1. On 2026-11-09 it was taken out of Terraform: the provider has one maintainer and an unaudited binary, and every plan ran it with all of this root's credentials, while it managed four settings and could not detect dashboard changes to tracking or TLS. A `removed` block took it out of state on 2026-11-09 without deleting it, and the provider then left the lock file. The full-access Resend key that only Terraform used is to be revoked; the Worker's sending-only key is unaffected.

The former sending domain `cup-audio.com` (f4b08144-5f30-4792-9491-3cac68af01b4) was deleted in the Resend dashboard on 2026-10-12 after the application moved to `cup.audio`, then removed from this configuration and from Terraform state.

## Cloudflare

The [Cloudflare configuration](production/cloudflare.tf) declares:

- The R2 bucket `create-audiobook-from-url-audio`, the Worker's `AUDIO_BUCKET`, in location `eeur`, with `prevent_destroy`.
- The hand-made DNS records of `cup.audio` and `cup-audio.com`: Resend's DKIM, `send` and `rsend` records, a `p=reject` DMARC policy on both zones, the `google-site-verification` TXT record of Cup's [Cloud Identity](../docs/production-configuration.md#cloud-identity) account on `cup.audio`, and on `cup-audio.com` a null MX and `v=spf1 -all`. The proxied AAAA records for the Worker's custom domains belong to Wrangler and stay out.
- Email Routing on `cup.audio`, which forwards `support@cup.audio`, `github@cup.audio`, `gcp@cup.audio` and `admin@cup.audio` to the operator (see [Support mail](#support-mail)).
- The Access application and its reusable allow policy that protect `cup.audio/api/operator/*` (see the [operator runbook](../apps/operator/README.md#configure-cloudflare-access)). The output `operator_access_audience` is the AUD tag the Worker's `OPERATOR_ACCESS_AUDIENCE` must equal.
- The AI Gateway `default`, which development and production share, with a spend limit of 30 USD per rolling 30 days and `prevent_destroy`. The Google AI Studio key in its key store is not managed here. Cup wants no rate limit from the gateway, because Google limits the project and the application waits out its rejections ([ADR 0008](../docs/adr/0008-synthesize-the-whole-narration-document.md)). Provider 5.28.1 requires one, so the configuration sets a ceiling of 10,000 requests per sliding 60 seconds, ten times the 1,000 requests per minute Google allowed for speech on 2026-10-11. If Google's limit rises toward the ceiling, raise the ceiling too.

Terraform generated the configuration from the live resources on 2026-11-09. On the same day, import blocks adopted the 13 resources from `main`, and the apply set the gateway's previously unset rate limit to the ceiling above; the following plan reported no changes. Plan and apply only from an up-to-date `main`: a checkout whose configuration lacks resources held in state proposes destroying them, and `prevent_destroy` guards only the bucket and the gateway.

The provider reads `CLOUDFLARE_API_TOKEN`. Store a Cloudflare API token under that name in `terraform/.env.local`, with Zone Read and DNS Edit for `cup.audio` and `cup-audio.com`, Zone Settings Edit and Email Routing Rules Edit for `cup.audio`, and the account permissions Workers R2 Storage Edit, Access: Apps and Policies Edit, AI Gateway Edit, and Email Routing Addresses Edit. Wrangler's OAuth login cannot serve as this token: it expires within hours and cannot request DNS, Access or AI Gateway permissions. Keep `CLOUDFLARE_API_KEY` out of the Terraform shell, because the provider treats that name as a global API key; the development token in `apps/cloudflare-worker/.env.local` uses it.

Not managed here:

- The bucket's default rule that aborts incomplete multipart uploads after seven days.
- The Resend records are copied from the Resend dashboard; when Resend changes them, update them here.

### Support mail

`support@cup.audio` is the public developer email of the Google Play developer account, `github@cup.audio` is the contact email of the `cup-audio` GitHub organization, `gcp@cup.audio` is the developer contact email of the Google Auth Platform in `cup-production`, and `admin@cup.audio` is the [Cloud Identity](../docs/production-configuration.md#cloud-identity) administrator, whose address Google requires to receive mail for its system notifications. [Cloudflare Email Routing](https://developers.cloudflare.com/email-routing/) receives all four and forwards them to the operator's private address, one rule per address; there is no catch-all rule, so mail to any other `cup.audio` address is rejected. Enabling Email Routing (`cloudflare_email_routing_dns.cup_audio`) adds and locks Cloudflare's MX records, an SPF record including `_spf.mx.cloudflare.net` and a DKIM record on the zone, so those records stay out of Terraform. Destroying that resource disables Email Routing.

The repository is public, so the destination address is the sensitive input variable `support_email_destination`, never committed. Store it as `TF_VAR_support_email_destination` in `terraform/.env.local`. When the destination is created or changed, Cloudflare mails it a verification link; the rules forward nothing until the operator clicks it. All rules share that one destination, so adding a rule for an already verified destination sends no new verification mail.

Enabling Email Routing fails while the zone has an MX record that is not Cloudflare's, and `cup.audio` had a null MX and `v=spf1 -all` until this configuration replaced them. The first apply therefore runs in two steps from an up-to-date `main`, removing the two former records before enabling Email Routing:

```sh
node --env-file=terraform/.env.local --input-type=module -e 'import cp from "node:child_process"; process.exitCode = cp.spawnSync("terraform", ["-chdir=terraform/production", "apply", "-target=cloudflare_dns_record.cup_audio_null_mx", "-target=cloudflare_dns_record.cup_audio_spf"], {stdio: "inherit"}).status;'
node --env-file=terraform/.env.local --input-type=module -e 'import cp from "node:child_process"; process.exitCode = cp.spawnSync("terraform", ["-chdir=terraform/production", "apply"], {stdio: "inherit"}).status;'
```

## Google Play uploader

The [Google Play configuration](production/google-play.tf) lets the Android release command upload to Google Play without a service account key. It enables the Android Publisher API in cup-production, together with the IAM API and the IAM Service Account Credentials API, which creating the service account and minting its tokens need; none of the three was enabled before. It creates the uploader service account `play-publisher@cup-production.iam.gserviceaccount.com`, which has no keys, and grants the operator's Google account `roles/iam.serviceAccountTokenCreator` on it, so the operator's application-default credentials can impersonate it. The output `play_publisher_service_account_email` names the account. Inviting it in the Play Console is manual; see [production configuration](../docs/production-configuration.md#google-play-uploads).

After apply, check that the operator can mint a token for the account; the grant can take a few minutes to take effect:

```sh
gcloud auth print-access-token --impersonate-service-account=play-publisher@cup-production.iam.gserviceaccount.com
```

## Google sign-in configuration

The Google Web application OAuth client is created manually in the cup-production Google Auth Platform project.
Store its ID and secret in `terraform/.env.local` as `TF_VAR_google_web_client_id` and `TF_VAR_google_web_client_secret`.
Terraform configures Supabase's Google provider from these values, with nonce validation enabled.
The web client asks Supabase to return to the current page, so the redirect allow-list holds `https://cup.audio/app` and `https://cup.audio/app/**`; Supabase also accepts any URL with the site URL's scheme and host. Native Android exchanges a Google ID token directly and needs no redirect URL. The iOS app runs the same OAuth flow in a system browser sheet that returns to `audio.cup.app://auth/callback`, so the allow-list holds that URL too ([ADR 0019](../docs/adr/0019-sign-in-on-ios-through-supabase-oauth-in-a-system-browser-sheet.md)); it needs no Google client of its own.
Google must allow the new Supabase callback shown above and JavaScript origin <https://cup.audio>.
The Android OAuth client must be registered for package `audio.cup.app`.
On 2026-10-26, after the allow-list apply, the operator signed in with Google on <https://cup.audio/app> and was returned to the starting page. Native Android sign-in remains unverified.
The Supabase provider preserves masked OAuth secrets in state, so a no-change plan does not prove the secret works or detect an out-of-band secret change.

## Apple client secret

The [apple-client-secret root](apple-client-secret/main.tf) writes one Supabase auth setting, `external_apple_secret`, the client secret Supabase's Apple provider sends to Apple for web and Android sign-in. The monthly [rotation workflow](../docs/production-configuration.md#apple-client-secret-rotation) signs a new secret with [`tooling/apple-client-secret`](../tooling/apple-client-secret/README.md) and applies this root with it as `TF_VAR_apple_client_secret`; [ADR 0118](../docs/adr/0118-rotate-supabases-apple-client-secret-from-a-scheduled-github-actions-workflow.md) records why. The root needs no other variable, and the Supabase provider reads `SUPABASE_ACCESS_TOKEN`.

[`supabase.tf`](production/supabase.tf) in the production root must never set `external_apple_secret`, and leaves it out on purpose. Supabase provider 1.11.0 refreshes, diffs and sends only the auth keys a configuration writes, so the two roots manage the same `supabase_settings` without drift and without overwriting each other. Were the production root to set the key, every apply that changes its auth settings would send the value in its own state and replace the newer secret the workflow wrote. Removing this root's resource from state, or destroying it, leaves the secret in Supabase.

The state holds the signed JWT in plain text, so only the operator and the workflow's service account can read the `apple-client-secret` prefix. To rotate by hand from an up-to-date `main`, sign a secret with the `.p8` key and apply it with the Supabase access token from `terraform/.env.local`:

```sh
terraform -chdir=terraform/apple-client-secret init
export TF_VAR_apple_client_secret="$(APPLE_SIGN_IN_PRIVATE_KEY="$(cat AuthKey_6Y358M9M9A.p8)" node tooling/apple-client-secret/src/cli.ts sign)"
node --env-file=terraform/.env.local --input-type=module -e 'import cp from "node:child_process"; process.exitCode = cp.spawnSync("terraform", ["-chdir=terraform/apple-client-secret", "apply"], {stdio: "inherit"}).status;'
unset TF_VAR_apple_client_secret
```

### GitHub Actions identity

[github-actions.tf](bootstrap/github-actions.tf) in the bootstrap root lets the rotation workflow, and nothing else, reach this root's state without a key:

- It enables the IAM, IAM Service Account Credentials and Security Token Service APIs in `cup-infrastructure`.
- The Workload Identity Federation pool `github` has one OIDC provider, `github`, for `https://token.actions.githubusercontent.com`, whose attribute condition admits only tokens for the repository `cup-audio/cup` (by name and ID), the environment `production` and the ref `refs/heads/main`.
- The service account `apple-client-secret-rotation@cup-infrastructure.iam.gserviceaccount.com` has no keys. Only the subject `repo:cup-audio/cup:environment:production` of that pool may impersonate it.
- The account holds Storage Object User on the state bucket under an IAM condition: objects under `apple-client-secret/`, and the bucket itself, which lets it list object names but read no other state.

The outputs `github_workload_identity_provider` and `apple_client_secret_rotation_service_account` are the values the workflow's `google-github-actions/auth` step names. Whether the GCS backend needs any permission beyond Storage Object User is confirmed only by the workflow's first run.

## Sentry

The [Sentry root](sentry/main.tf) manages Cup's Sentry production setup through the provider `jianyuan/sentry` 0.16.0 against `https://de.sentry.io/api/`, the API of Sentry's Germany region. It declares:

- The team `cup` and the projects `cup-worker` (the Worker) and `cup-app` (the web app and both shells), created without Sentry's default key and default alert rule.
- One key per project, with `prevent_destroy`, whose public DSNs are the outputs `cup_worker_dsn` and `cup_app_dsn`.
- In both projects, the inbound filters for browser extensions, web crawlers, localhost and every legacy browser Sentry has not deprecated, and spike protection with one notification action per project, Sentry's own email, for when it starts dropping events.
- The privacy settings the provider cannot set (see [Privacy settings](#privacy-settings)).
- The alerts and monitors in [alerts.tf](sentry/alerts.tf) (see [Alerts and monitors](#alerts-and-monitors)).

The first apply ran on 2026-11-16, and the plan after it showed no changes. The alerts and monitors were applied on 2026-11-17, after the deploy that added the health route, and the plan after that showed no changes.

### Organisation

The operator creates the organisation once in the Sentry UI: slug `cupaudio` (display name `cup.audio`), data storage location Germany, on the free Developer plan. The root reads it through the `sentry_organization` data source and never imports it, so no plan can change or delete it. If the slug differs, change `organization_slug` in [main.tf](sentry/main.tf).

### Token

The provider authenticates with a personal user auth token with the scopes `org:write`, `team:write`, `project:write`, `project:admin` and `alerts:write`. Creating a project with `default_key = false` deletes the key Sentry creates with it, which needs `project:admin`. Store it as `SENTRY_AUTH_TOKEN` in the ignored file `terraform/sentry/.env.local`. It is separate from the upload token that `sentry-cli` keeps in `~/.sentryclirc` for source maps and debug files. The drift checks also need it as the Terraform variable `sentry_auth_token`, which the command below sets from the same value. Plan and apply only from an up-to-date `main`:

```sh
terraform -chdir=terraform/sentry init
node --env-file=terraform/sentry/.env.local --input-type=module -e 'import cp from "node:child_process"; process.exitCode = cp.spawnSync("terraform", ["-chdir=terraform/sentry", "plan"], {stdio: "inherit", env: {...process.env, TF_VAR_sentry_auth_token: process.env.SENTRY_AUTH_TOKEN}}).status;'
```

Replace `plan` with `apply` to apply. The apply also runs `curl` (see [Privacy settings](#privacy-settings)).

### DSN handover

Sentry creates a key's DSN when Terraform creates the key. Read both with `terraform -chdir=terraform/sentry output` and copy them once into the DSN constants of `@cup/telemetry.core`. A DSN is public by design: it lets a client send events and nothing else. A replaced key gets a new DSN and silences every release still built with the old one, so the keys carry `prevent_destroy`.

### Privacy settings

The privacy rules at ingest come from committed JSON in [sentry/privacy](sentry/privacy):

- [organization-relay-pii-config.json](sentry/privacy/organization-relay-pii-config.json) holds the organisation's Advanced Data Scrubbing rules. They remove `$user.geo.city`, `$user.geo.subdivision` and `$user.geo.region`; remove `contexts.device.id` and `contexts.app.device_app_hash`; remove a `$user.id` that looks like a native installation ID (32 lowercase hex digits or an uppercase dashed UUID), so lowercase dashed account IDs pass; mask the values of the query parameters `token`, `key`, `sig`, `signature`, `auth`, `code` and `access_token` in breadcrumb URLs; and replace email addresses in every string as a backstop.
- [cup-worker-relay-pii-config.json](sentry/privacy/cup-worker-relay-pii-config.json) holds the `cup-worker` project rule that removes `$user.geo.**`, so the Worker's own events carry no location.

Two `terraform_data` resources in [privacy.tf](sentry/privacy.tf) send them with `curl`: the organisation's rules together with "Prevent storing IP addresses" (`scrubIPAddresses: true`) and "Show Generative AI Features" turned off (`hideAiFeatures: true`, so no member can send issue data to Sentry's AI features) through `PUT /api/0/organizations/cupaudio/`, and the project rule through `PUT /api/0/projects/cupaudio/cup-worker/`. They run again whenever the hash of what they send changes. Each request replaces every rule of its scope, so edit the files rather than the Sentry UI. In every plan, two `check` blocks read both settings through an `http` data source and warn when the live values differ from the committed ones. To restore drifted values without changing the files, replace the resource, for example with `-replace=terraform_data.organization_privacy_settings`. The `http` data source sends the token in a request header, which Terraform writes to state; this is accepted.

### Alerts and monitors

[alerts.tf](sentry/alerts.tf) declares what emails the operator; the [observability page](../docs/architecture/observability.md#alerts-and-monitors) describes when each fires. It uses Sentry's current monitor and alert model (`sentry_alert`), not the deprecated `sentry_issue_alert`:

- `sentry_alert.new_or_regressed_issue`, one per project, on the project's default issue stream monitor, which Sentry creates with the project and the `sentry_project_issue_stream_monitor` data source reads, and on the project's own metric monitors and, in `cup-worker`, the uptime monitor and the cron monitor. It fires on a new issue and on a resolved issue that comes back.
- `sentry_alert.conversion_failure_frequency`, on the default error monitor of `cup-worker`, for an issue tagged `cup.conversion.failure_category` that is seen more than 5 times in 1 h.
- `sentry_uptime_monitor.health`, in `cup-worker`, which requests `GET https://cup.audio/api/health` every minute and opens an issue after 3 consecutive checks without a 200. The free plan includes one uptime monitor.
- `sentry_cron_monitor.apple_client_secret_rotation`, in `cup-worker`, which expects a check-in from the [Apple client secret rotation](../docs/production-configuration.md#apple-client-secret-rotation) at 06:17 UTC on the 1st of each month, with a day's grace period, and opens an issue on the first missed or failed check-in. The free plan includes one cron monitor. The provider exposes no slug; Sentry derives the slug from the monitor's name, which is therefore already slug-shaped, `apple-client-secret-rotation`. The workflow checks in with an HTTP `GET` to `https://o4512441473040384.ingest.de.sentry.io/api/4512441485623377/cron/apple-client-secret-rotation/aa6ceda71485efec30877677d4eb919b/?status=ok`: the organisation's ingest host, the `cup-worker` project ID, the slug and the public key of the `cup-worker` DSN, which is public by design. Renaming the monitor changes the slug and breaks the check-in.
- `sentry_metric_monitor.daily_errors` and `.daily_spans`, one each per project, which open an issue when a project takes more than 150 errors (error and message events) or 165,000 spans in a day, about a thirtieth of the free plan's monthly 5k errors and 5M spans.

Every alert emails the team `cup` at most once an hour per issue (`frequency_minutes = 60`), so the operator must be a member of that team; a plan on 2026-11-16 found the token user, the operator, a member. Spike protection's notification is the separate `sentry_notification_action` above.

### Personal notifications

The alerts are meant to be the only source of Sentry email, so the operator turns Sentry's personal workflow notifications off once, in the Sentry UI under **User Settings → Notifications → Workflow**, set to send none (the API value `never`). Leave **Issue Alerts** on, which the alerts above need, and the quota and spike protection notifications too. Terraform cannot manage this: the personal notification endpoints accept no auth token whatever its scopes, only a signed-in session, and the provider has no resource for them.

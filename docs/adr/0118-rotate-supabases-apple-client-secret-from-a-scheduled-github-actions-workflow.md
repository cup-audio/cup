---
status: accepted
---

# Rotate Supabase's Apple client secret from a scheduled GitHub Actions workflow

Supabase's Apple provider signs web and Android sign-ins with a client secret: an ES256 JWT signed with the Sign in with Apple key `6Y358M9M9A`, which Apple accepts for at most six months. When it lapses, Apple sign-in on the web and on Android breaks; native iOS sign-in and the Worker, which signs its own secrets per request, are unaffected. The map [cup-audio/cup#465](https://github.com/cup-audio/cup/issues/465) decided who rotates it in [#510](https://github.com/cup-audio/cup/issues/510), how a workflow writes it with least privilege in [#514](https://github.com/cup-audio/cup/issues/514), and the spec [#519](https://github.com/cup-audio/cup/issues/519) collected the decisions. [#529](https://github.com/cup-audio/cup/issues/529) built it. Until then Cup had no CI ([ADR 0020](0020-validate-in-three-local-gates-that-trust-the-turbo-cache.md)), and production releases ran only from the operator's Mac ([ADR 0033](0033-ship-android-test-builds-from-the-operators-mac-to-google-plays-internal-testing-track.md)).

## Decision

- **A scheduled GitHub Actions workflow rotates the secret every month, unconditionally.** [`rotate-apple-client-secret.yml`](../../.github/workflows/rotate-apple-client-secret.yml) runs on the 1st of each month and on `workflow_dispatch`, and signs a secret valid for 179 days, so a run that fails leaves about five months to fix it. It is Cup's first CI. It narrows ADR 0020's "Cup has no CI" to this one job: the validation gates stay local and unchanged.
- **A dependency-free Node script signs the secret.** [`tooling/apple-client-secret`](../../tooling/apple-client-secret/README.md) uses only `node:crypto`, so the workflow runs it with the runner's `node`, with no `pnpm install` and no submodule. The operator can run it on the Mac too.
- **Its own Terraform root module writes it.** [`terraform/apple-client-secret`](../../terraform/apple-client-secret/main.tf) manages only `external_apple_secret` in Supabase's auth settings, with its state under its own prefix in the existing state bucket. `terraform/production` keeps every other auth setting and leaves this key out: the Supabase provider refreshes, diffs and sends only the keys a configuration writes, so the two roots never overwrite each other, while adding the key to production would send its stale value on every apply that touches `auth`.
- **The workflow reaches only that module.** Workload Identity Federation in `terraform/bootstrap` trusts only `cup-audio/cup`, the `production` environment and `refs/heads/main`, and its service account can read and write only objects under the module's state prefix. The workflow holds two secrets, the `.p8` key and a Supabase access token scoped to the production project, in the environment `production`, which admits only `main`, with administrator bypass off and no required reviewers. It runs with no `GITHUB_TOKEN` permission beyond `id-token: write`, reads secrets only through `env:`, is never triggered by `pull_request_target` or `workflow_run`, and uses no actions but SHA-pinned `hashicorp/setup-terraform` and `google-github-actions/auth`.
- **Failures surface three ways.** GitHub mails a failed run; a Sentry cron monitor, which the workflow checks in to after a successful apply, opens an issue for a missed or failed month, including when GitHub disables the schedule after 60 days without repository activity; and the web app reports a failed Apple web sign-in. From 30 days before the Supabase access token expires, the workflow fails with a message to renew it.

## Considered options

- **The operator rotates by hand from the Mac, as ADR 0033's reasoning would have it.** Rejected for this one key: a twice-yearly manual step with a hard deadline is the kind that gets forgotten, and a lapse breaks sign-in for listeners. Every other release and Terraform apply stays on the Mac.
- **Apply `terraform/production` from CI.** Rejected: it would put every production credential and the whole state within reach of a scheduled job and apply unreviewed plans.
- **A bare Management API `PATCH` of `external_apple_secret`.** Rejected: it needs no state, but leaves the secret outside Terraform, which the operator wanted to keep as the one writer of Supabase's configuration.
- **Required reviewers on the environment.** Rejected: with one person they would block every scheduled run.
- **Rotate only when the secret nears expiry, or verify the stored secret's hash after the apply.** Rejected: an unconditional monthly run is simpler, and the Sentry monitor catches a stopped schedule; only a real web Apple sign-in proves that Apple accepts the secret.

## Consequences

- The `.p8` key has three copies: the operator's password manager, the Worker secret and the GitHub environment. A leaked, lost or revoked key means replacing both copies before the next run ([runbook](../production-configuration.md#replace-the-sign-in-with-apple-key)).
- The scoped Supabase access token can also change any auth setting and delete or pause the production project, since Supabase offers nothing narrower for this endpoint; it expires within a year and its renewal is a yearly manual step ([runbook](../production-configuration.md#renew-the-supabase-access-token)).
- Anyone who can push to `main` can change the workflow to print the secrets, so a change to the workflow file needs the same review as any production change.
- Moving releases, deploys and the rest of Terraform to GitHub Actions, and merging this module back into `terraform/production`, is the operator's own later effort.
- As of 2026-11-23 the workflow, module and monitor are built but not yet applied or run: the cron monitor's check-in slug comes from Sentry deriving it from the monitor's name, and both the slug and Workload Identity Federation are confirmed only by the first `workflow_dispatch` run.

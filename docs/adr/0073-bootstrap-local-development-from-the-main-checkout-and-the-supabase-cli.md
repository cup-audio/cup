---
status: accepted
---

# Bootstrap local development from the main checkout and the Supabase CLI

A checkout needs ignored files (credentials, the optional Android upload keystore) and local services before it can build, test or run Cup. Worktree bootstrapping came with the commit "build: bootstrap fresh worktrees during install" and was extended for the upload keystore in [#449](https://github.com/cup-audio/cup/pull/449) (CUP-80); local Supabase came with "chore(auth): configure Supabase, Resend, and local authentication" and the test account and Tailscale access with [#74](https://github.com/cup-audio/cup/pull/74) ([ADR 0012](0012-offer-a-local-test-account-instead-of-google-in-development.md)); the Sentry token rule came with [#422](https://github.com/cup-audio/cup/pull/422). These decisions were recorded from code comments on 2026-11-23.

## Decision

Install hooks:

- A linked worktree starts without the ignored environment files and the optional Android upload keystore, so [postinstall](../../postinstall.sh) creates them from the main checkout.
- When the `.patricktree-stack` submodule is missing, [preinstall](../../preinstall.sh) initializes it and still fails: pnpm has already scanned the workspace without the submodule's packages, so the run cannot continue and must be retried.
- The Android upload key, created once with `android:upload-key:create` in `@cup/mobile-app`, is optional for [env setup](../../tooling/env-setup/src/cli.ts): only `android:release` needs it, so `check` never looks for it. Its path stays in step with `KEYSTORE_PATH` in [upload-key.mts](../../apps/mobile-app/scripts/release/upload-key.mts).
- Sentry's upload token stays out of every checkout ([deploy](../production-configuration.md#deploy)).

Local services ([dev-services.ts](../../tooling/env-setup/src/dev-services.ts), [supabase/config.toml](../../supabase/config.toml)):

- `pnpm dev:services` sets the `CUP_LOCAL_*` variables that `supabase/config.toml` reads: localhost URLs by default, or this machine's tailnet URLs with `--tailnet` ([local development](../local-development.md)). Every Supabase CLI command parses the config, so every command gets these variables.
- Google sign-in is optional locally: without a Google client, only the test account signs in.
- The local test account signs in with a password. The Supabase CLI turns the whole email provider on or off with one setting, so the email provider stays on; `false` would also refuse password sign-ins.
- The test account's password is fixed and short so it is easy to type on a phone; Supabase requires at least six characters. Its `user_metadata` carries a name, as Google sign-ins do, so the web app shows its initials ("ta") in the avatar.
- The Homebrew Tailscale CLI can lag behind the macOS app's daemon, so the tool prefers the CLI the app ships.
- `start --tailnet` leaves a marker while it serves the ports, so `stop` turns off only what it started. `supabase start` leaves a running stack as it is, including the URLs it was started with.
- Tokens carry the issuer Supabase was started with, so the Worker verifies against that URL. The Worker's `MEDIA_URL_SIGNING_KEY` is kept across restarts, so signed media URLs issued earlier stay valid.
- Local development never sends to Sentry: with a DSN next to `LOCAL_DEVELOPMENT=true`, every Worker invocation throws ([`@cup/telemetry.cloudflare`](../../libs/telemetry.cloudflare)), so no DSN is set, and the telemetry tunnel forwards nothing either.

## Consequences

- A fresh worktree installs without manual copying, as long as the main checkout is configured.
- A fresh checkout's first `pnpm install` can fail once by design, after initializing the submodule.
- The email provider cannot be turned off locally without losing the test account.

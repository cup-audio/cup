# Production configuration

Use this guide to supply the production Worker's configuration and the provider settings that Terraform does not manage, to find those it does, and to deploy. The [authentication](architecture/authentication.md) and [account deletion](architecture/account-deletion.md) pages explain the behavior this configuration enables. The [Terraform guide](../terraform/README.md) covers infrastructure state, the Supabase project, Supabase's Google provider, the Resend domain's settings and DNS records, and the Cloudflare R2 bucket, DNS records, operator Access application and AI Gateway, and [Sentry](../terraform/README.md#sentry)'s projects, keys, inbound filters, spike protection and privacy settings. Apple sign-in and native iOS account support are deferred.

## Worker configuration

The [Worker configuration](../apps/cloudflare-worker/wrangler.jsonc) declares plain variables, including rate limits and the Supabase URL, and lists the required secrets. A [configuration test](../apps/cloudflare-worker/test/wrangler-config.test.ts) pins its custom domains, compatibility and asset settings, Durable Object and Workflow bindings, Durable Object migrations, required secrets, Sentry DSN and telemetry tunnel allowlist, and observability settings, so changing them means updating that test deliberately. Cloudflare Workers Observability is off (invocation logs, Workers Logs, traces and Issues), and no source maps are uploaded to Cloudflare: the Worker reports to Sentry instead ([observability](architecture/observability.md), [ADR 0029](adr/0029-observe-production-with-sentrys-own-sdks-and-turn-cloudflares-observability-off.md)). `SENTRY_DSN` is a plain variable holding the public `cup-worker` DSN, and the `CF_VERSION_METADATA` binding gives every event its release. `SENTRY_TUNNEL_DSNS` is a plain variable listing, comma-separated, the DSNs the [telemetry tunnel](architecture/observability.md#telemetry-tunnel) forwards to: exactly the public `cup-app` DSN; Sentry's projects and keys are managed in the [Terraform guide's Sentry section](../terraform/README.md#sentry). The API server's [environment contract](../libs/api-server/src/api-server-environment.ts) defines every value it reads. Supply secrets with Wrangler; they never belong in committed files or browser configuration.

| Secret                     | Purpose                                                                                                                                                                                                                                                                           |
| -------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `SUPABASE_PUBLISHABLE_KEY` | Browser SDK configuration; intentionally public                                                                                                                                                                                                                                   |
| `SUPABASE_SECRET_KEY`      | Server-only identity administration and deletion                                                                                                                                                                                                                                  |
| `GOOGLE_WEB_CLIENT_ID`     | Web OAuth client and native Android ID-token audience                                                                                                                                                                                                                             |
| `RESEND_API_KEY`           | Sending-only transactional email access                                                                                                                                                                                                                                           |
| `CLOUDFLARE_API_KEY`       | AI Gateway access for narration content selection                                                                                                                                                                                                                                 |
| `SOURCE_PAGE_COOKIES_JSON` | Cookies sent when visiting source pages                                                                                                                                                                                                                                           |
| `MEDIA_URL_SIGNING_KEY`    | Signs [signed media URLs](architecture/authentication.md#signed-media-url) and [signed position URLs](architecture/authentication.md#signed-position-url); a random value of at least 32 bytes, such as `openssl rand -base64 32`. Rotating it invalidates every outstanding URL. |

The Worker's Resend key is sending-only; Terraform uses a separate management key.

## Identity providers

Use Supabase project `evwjipxgacwotgbmqtla` exclusively. Terraform configures its Google provider, JWT lifetime, and redirect settings in the [Supabase configuration](../terraform/production/supabase.tf); see the [Google sign-in configuration](../terraform/README.md#google-sign-in-configuration). Configure ES256 JWT signing, which Terraform does not manage. Keep Google client secrets in Supabase and Terraform.

Register the Android OAuth client for package `audio.cup.app` and its signing certificate; a client registered for the former package `com.cup_audio.app` does not match.

## Email

Deletion notices go to the Resend API at the `RESEND_BASE_URL` variable, `https://api.resend.com`, from the Resend domain described in the [Terraform guide](../terraform/README.md#resend-domain). Inspect notification outcomes with the [operator CLI](../apps/operator/README.md#list-account-deletions); provider acceptance is not proof of inbox delivery.

`support@cup.audio`, the Google Play developer email, is received by Cloudflare Email Routing and forwarded to the operator's private address, as the [Terraform guide](../terraform/README.md#support-mail) describes. No other `cup.audio` address receives mail.

## Deploy

Deploys are manual: no CI workflow deploys, and pushing to `main` deploys nothing. Deploy from the main checkout, on exactly the `main` commit that the [deploy gate](../AGENTS.md#validation-gates) passed on:

```sh
pnpm gate:deploy
```

Then deploy that commit:

```sh
pnpm --filter '@cup/cloudflare-worker' run deploy
```

The script builds the web app and the Worker, then runs `wrangler deploy` with the [Worker configuration](../apps/cloudflare-worker/wrangler.jsonc), which sets `LOCAL_DEVELOPMENT` to `"false"`. Wrangler authenticates with the operator's own login (`wrangler login`). Keep the Cloudflare credentials from `apps/cloudflare-worker/.env.local` out of the deploying shell: that token covers development AI calls only, and Wrangler fails the asset upload with "No access to the specified resource" when it uses it. `wrangler deployments list`, run in `apps/cloudflare-worker`, shows the version now serving traffic.

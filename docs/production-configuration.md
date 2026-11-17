# Production configuration

Use this guide to supply the production Worker's configuration and the provider settings that Terraform does not manage, to find those it does, and to deploy. The [authentication](architecture/authentication.md) and [account deletion](architecture/account-deletion.md) pages explain the behavior this configuration enables. The [Terraform guide](../terraform/README.md) covers infrastructure state, the Supabase project, Supabase's Google provider, the Resend domain's settings and DNS records, and the Cloudflare R2 bucket, DNS records, operator Access application and AI Gateway, and [Sentry](../terraform/README.md#sentry)'s projects, keys, inbound filters, spike protection, privacy settings, alerts and monitors. Sentry's personal notification settings are the one Sentry setting set by hand ([personal notifications](../terraform/README.md#personal-notifications)). Apple sign-in and native iOS account support are deferred.

## Worker configuration

The [Worker configuration](../apps/cloudflare-worker/wrangler.jsonc) declares plain variables, including rate limits and the Supabase URL, and lists the required secrets. A [configuration test](../apps/cloudflare-worker/test/wrangler-config.test.ts) pins its custom domains, compatibility and asset settings, Durable Object and Workflow bindings, Durable Object migrations, required secrets, Sentry DSN and telemetry tunnel allowlist, and observability settings, so changing them means updating that test deliberately. Cloudflare Workers Observability is off (invocation logs, Workers Logs, traces and Issues), and no source maps are uploaded to Cloudflare: the Worker reports to Sentry instead ([observability](architecture/observability.md), [ADR 0030](adr/0030-observe-production-with-sentrys-own-sdks-and-turn-cloudflares-observability-off.md)). `SENTRY_DSN` is a plain variable holding the public `cup-worker` DSN, and the `CF_VERSION_METADATA` binding gives every event its release. `SENTRY_TUNNEL_DSNS` is a plain variable listing, comma-separated, the DSNs the [telemetry tunnel](architecture/observability-clients.md#telemetry-tunnel) forwards to: exactly the public `cup-app` DSN; Sentry's projects and keys are managed in the [Terraform guide's Sentry section](../terraform/README.md#sentry). The API server's [environment contract](../libs/api-server/src/api-server-environment.ts) defines every value it reads. Supply secrets with Wrangler; they never belong in committed files or browser configuration.

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

Once per machine, log Sentry CLI in to the `cupaudio` organisation, from the repository so that it picks up the committed [`.sentryclirc`](../.sentryclirc):

```sh
pnpm --filter '@cup/cloudflare-worker' exec sentry-cli login
```

Paste an organisation auth token, which Sentry creates with the source map upload scope only (`org:ci`). Sentry CLI stores it in `~/.sentryclirc`, outside every checkout. The committed `.sentryclirc` holds only the organisation and the Germany region URL; keep the token out of it, out of `.env.local` (`pnpm env:check` fails on a `SENTRY_AUTH_TOKEN` there) and out of the deploying shell. An organisation auth token carries its region's URL, and Sentry CLI uses it, because it ignores a URL configured in another file than the token.

Then deploy that commit:

```sh
pnpm --filter '@cup/cloudflare-worker' run deploy
```

The [deploy script](../apps/cloudflare-worker/scripts/deploy.ts) runs these steps in order, and the first that fails aborts the deploy before anything goes live. There is no flag to deploy anyway; fix the cause and run it again.

1. `sentry-cli info` checks the Sentry token.
2. It builds the web app and the Worker; each build injects debug IDs and moves its source maps out of what is served and deployed ([release tracking](architecture/observability-operations.md#release-tracking)).
3. It uploads the web app's source maps to the `cup-app` project and the Worker's to `cup-worker`.
4. `wrangler deploy` deploys the Worker with the [Worker configuration](../apps/cloudflare-worker/wrangler.jsonc), which sets `LOCAL_DEVELOPMENT` to `"false"`.

The script makes no release API calls: Sentry creates a release from the first event that names it, and matches source maps by debug ID, not by release. Wrangler authenticates with the operator's own login (`wrangler login`). Keep the Cloudflare credentials from `apps/cloudflare-worker/.env.local` out of the deploying shell: that token covers development AI calls only, and Wrangler fails the asset upload with "No access to the specified resource" when it uses it. `wrangler deployments list`, run in `apps/cloudflare-worker`, shows the version now serving traffic.

## Native release

A release of the Android or iOS shell goes to the stores by hand. Before its store upload, upload the files Sentry needs to read the release's stack traces: the source maps of the web bundle packed into the build, and on iOS the archive's dSYMs ([release tracking](architecture/observability-operations.md#release-tracking)). Sentry CLI needs the same login as the [deploy](#deploy).

1. Build the shells from the commit being released, which builds the web app with its source maps and syncs the bundle into both native projects:

   ```sh
   pnpm --filter '@cup/mobile-app' build
   ```

2. Archive the release: in Xcode, **Product → Archive** with the Release configuration; in Android Studio, a signed release bundle.
3. Upload its symbols, passing the archive's absolute path for iOS (Xcode's Organizer shows it under **Show in Finder**):

   ```sh
   pnpm --filter '@cup/mobile-app' symbols:upload ios "/absolute/path/to/Cup.xcarchive"
   pnpm --filter '@cup/mobile-app' symbols:upload android
   ```

4. Upload the build to App Store Connect or the Play Console only if the step before succeeded.

`symbols:upload` runs [`upload-shell-symbols`](../tooling/source-maps/README.md#upload-shell-symbols). It refuses source maps whose debug IDs are not all in the bundle packed into the build, which happens when the web app was rebuilt after the sync; it checks the Sentry token with `sentry-cli info`; on iOS it uploads every dSYM of the archive and waits until Sentry has processed them; and it uploads the source maps to `cup-app`. The first failing step stops it with a message saying not to upload the build to the store; fix the cause and run it again. There is no Xcode build phase that uploads, and the script makes no release API calls.

**Store-side symbols.** The stores read crash reports themselves, which covers listeners who turned "Send crash reports" off. Keep "Include symbols for your app" on when uploading from Xcode's Organizer, so App Store Connect receives the dSYMs and Xcode Organizer's crash reports are symbolicated. Android stays unminified (`minifyEnabled false` in the app's `build.gradle`), so the Play Console's Android vitals read Java stack traces without a mapping file, and no R8 mapping exists to upload. Turning R8 on later makes uploading each release's mapping file to Sentry (`sentry-cli` or Sentry's Gradle plugin) and to the Play Console mandatory, and `symbols:upload` must then upload it.

**Store privacy forms**, filled in by the operator at the first release with Sentry and checked at every release:

- Apple's App Privacy labels in App Store Connect declare Diagnostics (crash data, performance data and other diagnostic data), linked to the user, not used for tracking, for app functionality. The app's [privacy manifest](../apps/mobile-app/ios/App/App/PrivacyInfo.xcprivacy) declares the same.
- Google Play's Data safety form declares App info and performance (crash logs and diagnostics), collected, not shared, for app functionality.

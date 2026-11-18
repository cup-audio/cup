# Production configuration

Use this guide to supply the production Worker's configuration and the provider settings that Terraform does not manage, to find those it does, and to deploy. The [authentication](architecture/authentication.md) and [account deletion](architecture/account-deletion.md) pages explain the behavior this configuration enables. The [Terraform guide](../terraform/README.md) covers infrastructure state, the Supabase project, Supabase's Google provider, the Resend domain's settings and DNS records, and the Cloudflare R2 bucket, DNS records, operator Access application and AI Gateway, the Google Play uploader service account, and [Sentry](../terraform/README.md#sentry)'s projects, keys, inbound filters, spike protection, privacy settings, alerts and monitors. Sentry's personal notification settings are the one Sentry setting set by hand ([personal notifications](../terraform/README.md#personal-notifications)). Apple sign-in and native iOS account support are deferred.

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

### Android OAuth clients

Native Google sign-in on Android needs an Android OAuth client for package `audio.cup.app` and the SHA-1 of the certificate that signed the installed app; a client registered for the former package `com.cup_audio.app` does not match. A client takes one SHA-1, so each certificate gets its own client, all in `cup-production` next to the web client ([#357](https://github.com/cup-audio/cup/issues/357)). The app passes only the web client's ID, so the Worker, Supabase and Terraform never see the Android clients' IDs. Terraform cannot manage OAuth clients ([#357](https://github.com/cup-audio/cup/issues/357)), so create, rename and delete them in the Google Cloud console. Fingerprints are not secret.

| Display name                                              | Certificate                                    | SHA-1                                                         |
| --------------------------------------------------------- | ---------------------------------------------- | ------------------------------------------------------------- |
| `Android audio.cup.app – debug keystore (operator's Mac)` | The operator Mac's `~/.android/debug.keystore` | `A3:38:65:6D:37:74:87:30:B2:1F:17:29:F5:F4:27:08:91:BE:4B:90` |

The debug-keystore client was created as `cup` and gets its display name in [#447](https://github.com/cup-audio/cup/issues/447); renaming keeps its client ID and fingerprint. Builds installed from Google Play carry Play's app signing certificate, not the upload key's. The app signing clients are added after the [first manual upload](../apps/mobile-app/README.md#first-upload-by-hand) fixes Play App Signing's keys ([#447](https://github.com/cup-audio/cup/issues/447)): one client per app signing SHA-1 that the Play app signing page lists, up to three with hybrid signing, each named `Android audio.cup.app – <certificate>` and added to the table. Cup keeps no client for the upload key, because sign-in is checked on Play-installed builds ([#366](https://github.com/cup-audio/cup/issues/366)).

- **Adding a client.** To let a build signed with another certificate sign in, such as a locally installed release build or a debug build from another machine, create an Android client for `audio.cup.app` with that certificate's SHA-1 and add a row here. `pnpm --filter '@cup/mobile-app' android:upload-key:create` printed the upload key's SHA-1, which `keytool -list -v -keystore apps/mobile-app/android/upload-keystore.jks -alias upload` prints again and the Play app signing page also lists. `keytool -list -v -keystore ~/.android/debug.keystore -alias androiddebugkey -storepass android` prints a machine's debug keystore SHA-1.
- **Unused clients.** Google deletes an OAuth client unused for six months, emailing 30 days before; a deleted client can be restored for 30 days. A client for a certificate that never signs an installed app, such as an app signing key that no device matches, may lapse this way, which is harmless.
- **Delay.** A new or changed client can take minutes to hours to apply.
- **Diagnosis.** When no client matches the installed certificate, the account picker opens but sign-in fails once an account is picked: Cup shows "Google sign-in could not be completed. Try again." and logcat shows `[16] Account reauth failed`. Add the missing fingerprint.

## Email

Deletion notices go to the Resend API at the `RESEND_BASE_URL` variable, `https://api.resend.com`, from the Resend domain described in the [Terraform guide](../terraform/README.md#resend-domain). Inspect notification outcomes with the [operator CLI](../apps/operator/README.md#list-account-deletions); provider acceptance is not proof of inbox delivery.

`support@cup.audio`, the Google Play developer email, and `github@cup.audio`, the contact email of the `cup-audio` GitHub organization, are received by Cloudflare Email Routing and forwarded to the operator's private address, as the [Terraform guide](../terraform/README.md#support-mail) describes. No other `cup.audio` address receives mail.

## Google Play developer account and app record

Cup's Android app is distributed through the Google Play developer account `Cup Audio`, a personal account owned by the Google account behind Cup's Google Cloud project, with `support@cup.audio` as its developer email. As of 2026-11-16 the account exists and its identity verification is pending ([#364](https://github.com/cup-audio/cup/issues/364)). The Play Console allows creating an app only once verification completes, so the app record for `audio.cup.app`, named Cup, with the internal testing track's tester list and opt-in link, is still to be created ([#365](https://github.com/cup-audio/cup/issues/365)). The package name becomes fixed with the first upload. Test builds reach testers through the internal testing track only; the store listing and a production release belong to [CUP-46](https://linear.app/cup-audio/issue/CUP-46/publish-the-android-app-to-google-play). Its app icon is already generated from the brand assets ([store listing icon](../apps/mobile-app/README.md#store-listing-icon)).

## Upload key

Google Play accepts only bundles signed with the app's upload key, and re-signs them with the app signing key that Google generates and keeps when the [first manual upload](../apps/mobile-app/README.md#first-upload-by-hand) enrolls the app in Play App Signing. The upload key is a keystore on the operator's Mac, `apps/mobile-app/android/upload-keystore.jks`, whose password is in the macOS Keychain, with a backup of both in the operator's password manager; the mobile app README describes [creating it](../apps/mobile-app/README.md#create-the-upload-key).

### Upload key reset

When the upload key is lost or compromised, Google can replace it; the app signing key, and with it every installed app, stays the same. Configuring Play App Signing needs admin permission in the Play Console, and Google states no turnaround for a reset.

1. Remove what is left of the old key, because the create command refuses while either part exists: the keystore file, and the Keychain item, with `security delete-generic-password -s cup-android-upload-key -a "$(id -un)"`.
2. Create a new key with `pnpm --filter '@cup/mobile-app' android:upload-key:create`, and back it up as the command says.
3. Export its certificate with `keytool -export -rfc -keystore apps/mobile-app/android/upload-keystore.jks -alias upload -file upload_certificate.pem`, entering the password that `security find-generic-password -s cup-android-upload-key -a "$(id -un)" -w` prints.
4. On the Play app signing page (**Protected with Play** → **Play Store protection** → **Manage Play app signing**), choose **Request upload key reset**, give the reason, and upload `upload_certificate.pem`.
5. Re-register any [Android OAuth client](#android-oauth-clients) made for the old upload certificate with the new certificate's SHA-1. Cup keeps none by default.

## Google Play uploads

Scripted uploads of Android test builds authenticate as the uploader service account `play-publisher@cup-production.iam.gserviceaccount.com`, which Terraform creates without keys, as the [Terraform guide](../terraform/README.md#google-play-uploader) describes. The release command impersonates it through the operator's application-default credentials (`gcloud auth application-default login`); no JSON key exists to store, back up or rotate.

Google Play grants the account nothing until it is invited, which Terraform cannot do. Once the account exists, invite it in the Play Console under **Users and permissions** → **Invite new users**, with the service account's email as the address. Grant it **View app information and download bulk reports (read-only)** and **Release apps to testing tracks**, either for the `audio.cup.app` app or account-wide, and send the invitation; a service account needs no acceptance. Grant nothing more: the account must not release to production or change the store listing.

## Deploy

Deploys are manual: no CI workflow deploys, and pushing to `main` deploys nothing. Deploy from the main checkout, on exactly the `main` commit that the [deploy gate](../AGENTS.md#validation-gates) passed on:

```sh
pnpm gate:deploy
```

Once per machine, log Sentry CLI in to the `cupaudio` organisation with `--global`. Without it, Sentry CLI writes the token into the `.sentryclirc` it finds above the working directory, which in a checkout is the committed one:

```sh
pnpm --filter '@cup/cloudflare-worker' exec sentry-cli login --global
```

The link the login opens lacks the organisation and fails; create the token at <https://cupaudio.sentry.io/settings/auth-tokens/> instead. Sentry creates an organisation auth token with the source map upload scope only (`org:ci`), and Sentry CLI stores it in `~/.sentryclirc`, outside every checkout. The committed `.sentryclirc` holds only the organisation and the Germany region URL; keep the token out of it, out of `.env.local` (`pnpm env:check` fails on a `SENTRY_AUTH_TOKEN` there) and out of the deploying shell. An organisation auth token names `https://sentry.io`, and Sentry CLI uses that URL instead of the configured one, with a warning; `sentry.io` forwards the organisation's requests to the Germany region.

Then deploy that commit:

```sh
pnpm --filter '@cup/cloudflare-worker' run deploy
```

The [deploy script](../apps/cloudflare-worker/scripts/deploy.ts) runs these steps in order, and the first that fails aborts the deploy before anything goes live. There is no flag to deploy anyway; fix the cause and run it again.

1. `sentry-cli info` checks the Sentry token.
2. It empties the folders that hold the served build and its source maps, because Turbo restores a cached build over a folder's old files without removing them, which would otherwise upload and deploy every earlier build's files.
3. It builds the web app and the Worker; each build injects debug IDs and moves its source maps out of what is served and deployed ([release tracking](architecture/observability-operations.md#release-tracking)).
4. It uploads the web app's source maps to the `cup-app` project and the Worker's to `cup-worker`.
5. `wrangler deploy` deploys the Worker with the [Worker configuration](../apps/cloudflare-worker/wrangler.jsonc), which sets `LOCAL_DEVELOPMENT` to `"false"`.

The script makes no release API calls: Sentry creates a release from the first event that names it, and matches source maps by debug ID, not by release. Wrangler authenticates with the operator's own login (`wrangler login`). Keep the Cloudflare credentials from `apps/cloudflare-worker/.env.local` out of the deploying shell: that token covers development AI calls only, and Wrangler fails the asset upload with "No access to the specified resource" when it uses it. `wrangler deployments list`, run in `apps/cloudflare-worker`, shows the version now serving traffic.

## Native release

A release of the iOS shell goes to App Store Connect by hand; Android test builds go to Google Play through [`android:release`](../apps/mobile-app/README.md#release-builds), which uploads the Android symbols itself before Play sees the bundle, and with `--skip-upload` prints the `symbols:upload` command for its bundle. Before a store upload, upload the files Sentry needs to read the release's stack traces: the source maps of the web bundle packed into the build, on iOS the archive's dSYMs, and on Android R8's mapping file ([release tracking](architecture/observability-operations.md#release-tracking)). Sentry CLI needs the same login as the [deploy](#deploy).

For iOS:

1. Build the shells from the commit being released, which empties the web app's earlier build output, builds the web app with its source maps and syncs the bundle into both native projects:

   ```sh
   pnpm --filter '@cup/mobile-app' build
   ```

2. Archive the release in Xcode, **Product → Archive** with the Release configuration.
3. Upload its symbols, passing the archive's absolute path (Xcode's Organizer shows it under **Show in Finder**):

   ```sh
   pnpm --filter '@cup/mobile-app' symbols:upload ios "/absolute/path/to/Cup.xcarchive"
   ```

4. Upload the build to App Store Connect only if the step before succeeded.

`symbols:upload` runs [`upload-shell-symbols`](../tooling/source-maps/README.md#upload-shell-symbols). It refuses source maps whose debug IDs are not all in the bundle packed into the build, which happens when the web app was rebuilt after the sync; it checks the Sentry token with `sentry-cli info`; on iOS it uploads every dSYM of the archive and waits until Sentry has processed them; on Android it refuses an R8 mapping file whose ProGuard UUID differs from the one the build embedded, then uploads it; and it uploads the source maps to `cup-app`. The first failing step stops it with a message saying not to upload the build to the store; fix the cause and run it again. There is no Xcode build phase that uploads, and the script makes no release API calls.

**Store-side symbols.** The stores read crash reports themselves, which covers listeners who turned "Send crash reports" off. Keep "Include symbols for your app" on when uploading from Xcode's Organizer, so App Store Connect receives the dSYMs and Xcode Organizer's crash reports are symbolicated. Android release builds are shrunk by R8 ([#444](https://github.com/cup-audio/cup/issues/444)). AGP embeds the mapping file in the bundle, so the Play Console's Android vitals read Java stack traces without a separate upload. Sentry gets the same mapping file through `symbols:upload`: the release build writes the mapping file's ProGuard UUID into its `sentry-debug-meta.properties` asset (`GenerateSentryDebugMetaTask` in the app's `build.gradle`), and the Android SDK sends it with every event, so Sentry deobfuscates Java frames with that mapping file.

**Store privacy forms**, filled in by the operator at the first release with Sentry and checked at every release:

- Apple's App Privacy labels in App Store Connect declare Diagnostics (crash data, performance data and other diagnostic data), linked to the user, not used for tracking, for app functionality. The app's [privacy manifest](../apps/mobile-app/ios/App/App/PrivacyInfo.xcprivacy) declares the same.
- Google Play's Data safety form declares App info and performance (crash logs and diagnostics), collected, not shared, for app functionality.

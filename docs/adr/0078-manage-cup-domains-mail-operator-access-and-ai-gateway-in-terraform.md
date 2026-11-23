---
status: accepted
---

# Manage Cup's domains, mail, operator access and AI Gateway in Terraform

`terraform/production` holds Cup's Cloudflare resources and the Google Play uploader. The Cloudflare resources were adopted in [#188](https://github.com/cup-audio/cup/pull/188), which also dropped the Resend provider; mail forwarding grew in [#428](https://github.com/cup-audio/cup/pull/428) (support@), [#453](https://github.com/cup-audio/cup/pull/453) (github@) and [#507](https://github.com/cup-audio/cup/pull/507) (gcp@ and admin@, CUP-35); the Cloud Identity domain verification came with CUP-35; the uploader came with Android test builds through Google Play's internal testing track ([#449](https://github.com/cup-audio/cup/pull/449), CUP-80, [ADR 0033](0033-ship-android-test-builds-from-the-operators-mac-to-google-plays-internal-testing-track.md)). These decisions were recorded from code comments on 2026-11-23.

## Decision

Cloudflare ([cloudflare.tf](../../terraform/production/cloudflare.tf)):

- The provider reads `CLOUDFLARE_API_TOKEN` from the environment ([terraform/README.md](../../terraform/README.md#cloudflare) lists its permissions). Zones are given by ID rather than looked up, so plans need no zone-wide read beyond the records managed here.
- The R2 bucket behind the Worker's `AUDIO_BUCKET` binding holds every listener's narration audio.
- The proxied AAAA records for the Worker's custom domains belong to Wrangler and stay out of Terraform.
- Resend's sending records for cup.audio must match the domain's records in the Resend dashboard.
- cup.audio receives mail through Email Routing, which adds and locks its own MX, SPF and DKIM records, so they stay out of Terraform. Neither domain's SPF authorizes Resend: it signs with DKIM, which DMARC accepts. cup-audio.com receives no mail and authorizes no sender through SPF.
- Email Routing forwards `support@cup.audio` (the Google Play developer email), `github@cup.audio` (the contact email of the cup-audio GitHub organization), `gcp@cup.audio` (the developer contact email of the Google Auth Platform in cup-production) and `admin@cup.audio` (the Cloud Identity administrator that receives Google's system notifications) to the operator's private inbox. With no catch-all rule, mail to any other address is rejected. Cloudflare sends the destination a verification link that must be clicked once before the rules forward anything.
- The TXT record that proves to Google that Cup's Cloud Identity account owns cup.audio is kept after verification, since Google's admin recovery relies on proving ownership of the domain through DNS.
- Cloudflare Access sits in front of the operator API; the Worker validates the Access JWT against `OPERATOR_ACCESS_AUDIENCE` and `OPERATOR_EMAIL` in [the Worker's Wrangler config](../../apps/cloudflare-worker/wrangler.jsonc).
- Narration content selection and speech synthesis call one AI Gateway, in development and production alike. The Google AI Studio key it uses lives in its key store and is not managed here.
- The provider requires a gateway rate limit, but Cup wants none from the gateway: Google limits the project (1,000 requests per minute for speech on 2026-10-11, [ADR 0008](0008-synthesize-the-whole-narration-document.md)) and the application waits out its rejections. The ceiling is ten times that limit, so Google's always applies first.
- A spend cap of 30 USD per rolling 30 days caps runaway cost.

Google Play ([google-play.tf](../../terraform/production/google-play.tf)):

- The release command impersonates the uploader service account through the operator's application-default credentials, so no service account key exists. Inviting the account in the Play Console is manual ([production configuration](../production-configuration.md)).
- Creating a service account needs the IAM API and minting its tokens needs the IAM Service Account Credentials API; neither was enabled in cup-production on 2026-11-16, so Terraform enables them.

## Consequences

- Records owned by Wrangler or Email Routing never appear in a plan, and nothing in Terraform detects their drift.
- Adding a forwarded address is a Terraform change; any address without a rule bounces.
- The gateway never throttles before Google does, so the application's own waiting handles every rate limit.

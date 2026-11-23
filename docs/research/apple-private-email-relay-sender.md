# Apple Private Email Relay sender registration for Cup's Resend mail

Research date: 2026-11-23, for the wayfinder research ticket [Which sender does Cup register for Apple's Private Email Relay, and does Resend's DKIM-only setup pass it?](https://github.com/cup-audio/cup/issues/515), part of the map [Sign in with Apple, native on iOS](https://github.com/cup-audio/cup/issues/465). Sources are Apple's developer documentation and news, Resend's documentation, and public DNS answers for `cup.audio`, all read on the research date. Nothing was signed in to or changed at Apple, Resend or Cloudflare. Points marked _unverified_ were not settled by a primary source and need a live delivery test or a look at the console.

## Question

Cup accepts Sign in with Apple relay addresses as full account emails, so its Resend mail, today only the account deletion notices, must pass Apple's Private Email Relay. Which sender does Cup register on team `4GQ2V3WJW8` (the domain `cup.audio`, the sending address, or both)? Does the current Resend setup pass Apple's authentication check? Which DNS records must Terraform add, what does Apple's console show once a sender verifies, what happens to mail from an unregistered or failing sender, and do both relay domains behave the same?

## Answer

Register the domain `cup.audio` as an email source, and also its two Resend return-path subdomains `send.cup.audio` and `rsend.cup.audio`; three of the 32 sources an individual membership allows. Cup's mail passes Apple's DKIM check as it stands, and Apple accepts DKIM alone, so Terraform adds no DNS record. Registering the return-path subdomains also lets the SPF check pass, which Apple recommends but does not require. The relay bounces mail from an unregistered source. Registration is per team, not per relay domain. What the console's SPF column shows for `cup.audio`, and which return-path subdomain Cup's mail actually carries, are _unverified_ and settled by the live Hide My Email delivery test.

## Cup's sender as it stands

Cup sends from `Cup <no-reply@cup.audio>`, the only `from` address in the repository ([`resend-email.ts`](../../libs/registry/src/providers/resend-email.ts)). The Resend domain is `cup.audio` in Ireland (eu-west-1), with open and click tracking disabled and the custom return path left unspecified ([Terraform guide](../../terraform/README.md#resend-domain)).

Terraform declares three Resend records on `cup.audio`: the DKIM key as a TXT record at `resend._domainkey.cup.audio`, a CNAME from `send.cup.audio` to `send.forge.rmta.net`, and a CNAME from `rsend.cup.audio` to `rsend-euw1.forge.rmta.net`; `_dmarc.cup.audio` publishes `v=DMARC1; p=reject; sp=reject` ([`cloudflare.tf`](../../terraform/production/cloudflare.tf)).

Public DNS on the research date, queried through Cloudflare's resolver, matched Terraform and showed what the CNAMEs carry. `send.cup.audio` resolves to a TXT record `v=spf1 ip4:52.3.252.119 ip4:44.222.39.36 ip4:199.249.231.0/24 ~all` and an MX record `10 feedback.forge.rmta.net`. `rsend.cup.audio` resolves to `v=spf1 include:amazonses.com ~all` and an MX record `10 feedback-smtp.eu-west-1.amazonses.com`. `cup.audio` itself publishes `v=spf1 include:_spf.mx.cloudflare.net ~all`, the record Cloudflare Email Routing adds and locks, and its MX records point at Cloudflare's `route1` to `route3.mx.cloudflare.net`.

So the ticket's premise needs one correction: `cup.audio`'s own SPF does not authorize Resend, but both return-path subdomains do publish SPF records that authorize Resend's senders, through the CNAMEs. The comment in `cloudflare.tf` that "neither domain's SPF authorizes Resend" holds for `cup.audio` and `cup-audio.com`, not for `send.cup.audio` or `rsend.cup.audio`.

Resend documents this layout. A domain whose sending records are CNAMEs uses the return-path subdomain for one record and an `r`-prefixed sibling for the other, and both must exist for the domain to verify; the default return path is `send` ([Resend custom return path](https://resend.com/docs/dashboard/domains/custom-return-path)). Resend Forge, its own sending infrastructure, uses a return-path CNAME to `send.forge.rmta.net`, and Resend moves a domain's sending onto Forge gradually, falling back to its older engine when Forge cannot deliver ([Resend Forge](https://resend.com/docs/resend-forge), [Enable Forge API](https://resend.com/docs/api-reference/domains/enable-forge)). The DNS fits that: `send.cup.audio` authorizes Forge's own IP addresses, `rsend.cup.audio` authorizes Amazon SES in eu-west-1, the older engine. Which of the two names appears in the envelope sender of a given message, and whether it varies by engine, Resend's docs do not say (_unverified_).

## What Apple checks

Apple requires every message through the relay to be authenticated with "SPF and/or DKIM", and recommends both where possible ([Apple: configure Private Email Relay](https://developer.apple.com/help/account/capabilities/configure-private-email-relay-service)).

For SPF, Apple checks the envelope sender, not the `From:` header: the domain in the envelope sender, which Apple also calls the MAIL FROM, bounce or Return-Path address, must be registered, must pass SPF, and must match the registered domain exactly ([Apple: configure Private Email Relay](https://developer.apple.com/help/account/capabilities/configure-private-email-relay-service)). For Cup that domain is `send.cup.audio` or `rsend.cup.audio`, never `cup.audio`, so registering `cup.audio` alone gives no SPF pass, and its locked SPF record not naming Resend does not matter.

For DKIM, Apple matches the `d=` domain of the signature against the domain of the `From:` address, which must be registered; the signature must verify, must cover the `From:` header, and the two domains must match exactly ([Apple: configure Private Email Relay](https://developer.apple.com/help/account/capabilities/configure-private-email-relay-service)). Apple names DKIM as the path for senders whose email service provider puts its own domain in the envelope sender. Resend signs with the selector `resend` under `cup.audio` (the key at `resend._domainkey.cup.audio`), so `d=cup.audio` matches `no-reply@cup.audio` exactly; that the signature covers `From:` follows from DKIM itself, which requires it ([RFC 6376, section 5.4](https://www.rfc-editor.org/rfc/rfc6376#section-5.4)).

After either check passes, the relay also matches "the source email or domain" against the registered domains or addresses, and every source domain or subdomain in use must be registered separately: registering `example.com` does not cover `help.example.com` ([Apple: configure Private Email Relay](https://developer.apple.com/help/account/capabilities/configure-private-email-relay-service)).

So DKIM alone suffices by Apple's current wording, and Cup passes it with `cup.audio` registered. Apple's older overview still says registration plus SPF ([Apple: communicating using the private email relay service](https://developer.apple.com/documentation/signinwithapple/communicating-using-the-private-email-relay-service)); the configuration page is the more specific one and permits either.

## What to register

Register `cup.audio` as a domain. It covers `no-reply@cup.audio` and any later `cup.audio` sender, and it is the domain the DKIM check matches. Apple offers registering individual addresses for senders that do not own a domain configured for email ([Apple: configure Private Email Relay](https://developer.apple.com/help/account/capabilities/configure-private-email-relay-service)); Cup owns `cup.audio`, so the domain is the better fit, and registering `no-reply@cup.audio` too adds nothing Apple documents.

Also register `send.cup.audio` and `rsend.cup.audio`. They are what Apple's SPF check compares with, and registering both covers whichever one Resend puts in the envelope. Resend's own guide for relay recipients says to register the primary domain and the return-path subdomain ([Resend: sending to Apple Private Relay](https://resend.com/docs/knowledge-base/sending-apple-private-relay)); the same guide says, without a source, to register every sending address too, which Apple's page does not require once the domain is registered.

The three sources fit easily: an individual membership can register 32 email sources, an organization 100 ([Apple: configure Private Email Relay](https://developer.apple.com/help/account/capabilities/configure-private-email-relay-service)). The console work is under Certificates, Identifiers & Profiles, Services, "Sign in with Apple for Email Communication", Configure, then the add button in Email Sources, with a comma-separated list of domains.

If Resend's return path ever changes, for example by recreating the domain with a custom return path, the new subdomain needs registering too; Resend fixes the return path at domain creation ([Resend custom return path](https://resend.com/docs/dashboard/domains/custom-return-path)).

## DNS records Terraform must add

None. Apple needs no verification file for domains and subdomains ([Apple: configure Private Email Relay](https://developer.apple.com/help/account/capabilities/configure-private-email-relay-service)) and documents no verification TXT record. Apple says every registered domain "must create" an SPF TXT record: `cup.audio` has Email Routing's, and both return-path subdomains have Resend's through their CNAMEs. Cup cannot add Resend to `cup.audio`'s SPF anyway, since Email Routing locks it, and doing so would not help, because Apple's SPF check never looks at `cup.audio`.

## What the console shows

After registering, the email sources table shows whether each registered source passed an SPF check; for a registered address it shows whether the address's domain passed ([Apple: configure Private Email Relay](https://developer.apple.com/help/account/capabilities/configure-private-email-relay-service)). Apple documents no DKIM column and no other status. Expected, but _unverified_: `send.cup.audio` and `rsend.cup.audio` pass. What `cup.audio` shows is unclear, because Apple does not say whether its check only requires an SPF record to exist, which `cup.audio` has, or evaluates it against something; a failing mark on `cup.audio` would still leave the DKIM path, which the console does not show.

## Unregistered or failing senders

Apple states one outcome: mail from a source domain or address that is not registered "will result in a bounce message" ([Apple: configure Private Email Relay](https://developer.apple.com/help/account/capabilities/configure-private-email-relay-service)). Apple does not separately state what happens to a registered source whose mail fails both SPF and DKIM; a bounce is the likely reading but is _unverified_. Apple does not describe silent drops.

Apple periodically notifies the Account Holder and team admins when it detects mail from the team that the relay could not deliver, a setting they can turn off ([Apple: configure Private Email Relay](https://developer.apple.com/help/account/capabilities/configure-private-email-relay-service)). The relay also rejects all future mail to an address whose user stopped forwarding, and each relay address has a daily limit of 100 messages, replies included ([Apple: communicating using the private email relay service](https://developer.apple.com/documentation/signinwithapple/communicating-using-the-private-email-relay-service)). Resend reports a bounce as a hard, soft or undetermined bounce ([Resend email bounces](https://resend.com/docs/dashboard/emails/email-bounces)); Cup's notice delivery treats a permanent rejection as final and raises the `account-deletion-notice-undelivered` warning ([account deletion](../architecture/account-deletion.md)).

## Relay domains

Sign in with Apple relay addresses end in `@private.icloud.com`, `@privaterelay.appleid.com` or `@icloud.com` ([Apple: communicating using the private email relay service](https://developer.apple.com/documentation/signinwithapple/communicating-using-the-private-email-relay-service)). Apple announced on 2026-06-15 that both Sign in with Apple and iCloud+ Hide My Email would move to `private.icloud.com` ([Apple news, 2026-06-15](https://developer.apple.com/news/?id=sus6t6ab)), then revised that on 2026-08-24: only new Sign in with Apple addresses move to `private.icloud.com` "later this year", existing `privaterelay.appleid.com` addresses keep forwarding, and iCloud+ Hide My Email stays on `icloud.com` ([Apple news, 2026-08-24](https://developer.apple.com/news/?id=1ptvdtcm)).

Email sources are registered per developer team with no relay domain in the setup, and Apple describes one set of authentication rules for the service ([Apple: configure Private Email Relay](https://developer.apple.com/help/account/capabilities/configure-private-email-relay-service)), so both domains should behave the same. Apple does not say so explicitly (_unverified_), and whether new addresses are already issued on `private.icloud.com` on the research date is unknown. Resend's relay guide predates the change and names only `privaterelay.appleid.com` ([Resend: sending to Apple Private Relay](https://resend.com/docs/knowledge-base/sending-apple-private-relay)).

## Left for the live delivery test

The map's acceptance check already requires that email to a Hide My Email address arrives. That test should also record:

1. The `Return-Path` of one Cup notice delivered to an ordinary mailbox, to see which of `send.cup.audio` and `rsend.cup.audio` Resend uses, and whether it changes as Resend moves the domain onto Forge.
2. The console's SPF column for `cup.audio`, `send.cup.audio` and `rsend.cup.audio` right after registering them.
3. A notice to a relay address arriving, with the relay's `Authentication-Results` header showing which of SPF and DKIM passed; the relay domain of the test address, and if possible one address on each of `privaterelay.appleid.com` and `private.icloud.com`.
4. Optionally, a send to a relay address before registering, or from an unregistered sender, to see the bounce Resend records and whether Apple's undeliverable notification follows.

Two side notes for the spec, outside the ticket's question. A user's reply goes back to `no-reply@cup.audio` through the relay ([Apple: communicating using the private email relay service](https://developer.apple.com/documentation/signinwithapple/communicating-using-the-private-email-relay-service)), and no Email Routing rule receives that address ([production configuration](../production-configuration.md#email)), so replies are rejected, as they already are for every other recipient. And how `cup.audio`'s `p=reject` DMARC policy interacts with the relay's forwarding to the user's own mailbox is not documented by Apple; the delivery test covers it in practice.

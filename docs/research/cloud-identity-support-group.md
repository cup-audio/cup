# A `support@cup.audio` Google Group through Cloud Identity Free

Research date: 2026-11-22, for [CUP-35](https://linear.app/cup-audio/issue/CUP-35/change-the-google-oauth-support-email-to-supportcupaudio-before-launch). Sources are Google's own documentation, read on the research date; Google moved many Admin Help pages from `support.google.com/a` to `knowledge.workspace.google.com` and many Cloud pages to `docs.cloud.google.com`, and the links below are the pages the old URLs redirect to. Nothing was signed in to or changed at Google or Cloudflare. Points marked _unverified_ were not confirmed by a primary source and need the operator to observe them during setup.

Outcome, 2026-11-22: the recommended sequence worked, with two corrections observed during setup. The Branding page listed `support@cup.audio` under "Google Groups managed by you" only after `admin@cup.audio` was added to the group as a member with the Owner role; being the domain's administrator did not count. The project role used was Writer, which the console offers in place of the Editor role it marks as legacy. The [production configuration guide](../production-configuration.md#cloud-identity) describes the result.

## Question

Cup's production Google Cloud project `cup-production` is owned by the operator's consumer Google account and belongs to no Google Cloud Organization. The Google Auth Platform's Branding page should show `support@cup.audio` as the user support email, a field that accepts only the signed-in account's own address or a Google Group that account manages ([production configuration](../production-configuration.md#google-auth-platform-branding)). `cup.audio`'s DNS is on Cloudflare and managed by Terraform, and its MX records belong to Cloudflare Email Routing, which forwards `support@cup.audio`, `github@cup.audio` and `gcp@cup.audio` to the operator and must stay ([Terraform guide](../../terraform/README.md#support-mail)). Does signing up for Cloud Identity Free on `cup.audio` and creating a Google Group `support@cup.audio` get there, what does sign-up create and require, and what side effects does it have?

## Answer

Yes, with one caveat about who must be signed in. Cloud Identity Free costs nothing, needs no Gmail and no MX change, includes Google Groups, and its sign-up creates an administrator account such as `admin@cup.audio`. The Google group `support@cup.audio` can exist while Cloudflare keeps receiving the mail. Google documents that the group must be "managed by the currently logged-in user", but not whether the dropdown lists a `cup.audio` group for a consumer account that manages it from outside the domain (_unverified_), so the setup below has the group's owner, a `cup.audio` account, pick it. The side effect to accept: once a `cup.audio` account uses the Google Cloud console, Google creates an Organization resource for `cup.audio` with its default security policies; `cup-production` stays under "No organization" unless someone migrates it.

Recommended sequence for the operator:

1. Add a Cloudflare Email Routing rule, in Terraform, that forwards `admin@cup.audio` to the operator, because Google sends Cloud Identity system notifications to the administrator address and requires the domain to have mail service or forwarding for it ([set up Cloud Identity][ci-setup]). MX stays on Cloudflare.
2. Sign up at the [Cloud Identity Free sign-up page][ci-signup] with the operator's private address as the "current work email" (used for recovery), the business name, `cup.audio` as the domain, and the administrator username `admin@cup.audio`, then accept the Cloud Identity Agreement ([set up Cloud Identity][ci-setup]).
3. Copy the `google-site-verification=…` value from the Admin console's domain verification step, add it to `terraform/production/cloudflare.tf` as a TXT record on `cup.audio`, apply, and click verify; Google may take up to 72 hours to see it ([verify your domain][ci-verify], [TXT record][txt-record]).
4. Secure `admin@cup.audio`: 2-Step Verification with security keys, recovery phone and email, printed backup codes, and use it only for admin tasks ([admin account best practices][admin-best-practices]).
5. Check Admin console → Users and the transfer tool for unmanaged users: an existing consumer account `support@cup.audio` would block the group address ([migrating consumer accounts][migrate-consumer], [duplicate account conflicts][duplicate-conflicts]). None is expected.
6. In Admin console → Directory → Groups, create the group `support@cup.audio` with `admin@cup.audio` as its owner, and restrict who can post and who can view conversations to the group's owners ([create a group][create-group]); the group receives no mail, since mail to `support@cup.audio` keeps going to Cloudflare.
7. In `cup-production`'s IAM, grant `admin@cup.audio` the Editor role (or Owner), sign in to the Google Cloud console as `admin@cup.audio`, open Google Auth Platform → Branding, and pick `support@cup.audio` as the user support email. Google's own workaround for a non-Gmail support address is this route: make the account "a project editor or owner", then sign in with it so it appears in the dropdown ([manage OAuth app branding][branding]).
8. Optionally remove `admin@cup.audio`'s project role afterwards. Whether a later save of the Branding page by the operator's consumer account keeps a group the consumer account does not manage is _unverified_, so keep the role until a later save is observed to work, or save branding changes as `admin@cup.audio`.

A cheaper first attempt, before step 7, is to make the operator's consumer account a manager of the group and look at the dropdown while signed in as the consumer account. That needs external members turned on, first in the Groups for Business sharing settings and then on the group, which loosens the defaults; whether the group then appears is _unverified_.

## Cloud Identity Free sign-up

A non-Workspace customer goes to the Cloud Identity Free sign-up page (`workspace.google.com/gcpidentity/signup?sku=identitybasic`) and follows the wizard: first and last name, a current work email that "will be used as a recovery address" and must differ from the new admin account, business name and country, the domain already owned, then an admin username and password. Google recommends a username in the form `admin@example.com`; "This account is your Cloud Identity administrator account". Before continuing, the operator accepts the Cloud Identity Agreement on behalf of the organization. Google also lists, for the Free edition, "the administrator username and password to your domain registrar" as a requirement, which here means access to Cloudflare DNS. Source: [Set up Cloud Identity as a Google Cloud admin][ci-setup].

The first account is the Cloud Identity administrator; the setup page does not call it a super administrator, but the Resource Manager documentation refers to the account that creates the Organization resource as the super admin ([creating and managing organizations][org-create]). That the sign-up's first account is a super administrator is _unverified_ from these pages, though it is the only administrator and has to be able to verify the domain and create groups.

Payment information and a phone number are not mentioned as requirements on the setup page; whether the wizard asks for a phone number, for example for verification, is _unverified_.

Limits and cost: "When you sign up for a free Cloud Identity account, your user cap increases by 50", and a super administrator can request more by form ([how licensing works][ci-licensing], [editions][ci-editions]). The licenses are free ("they automatically get a free Cloud Identity license"), and the free subscription cannot be cancelled to reduce licenses ([how licensing works][ci-licensing]). The editions page lists no price for Free, while Premium has a billing row ([editions][ci-editions]); the pricing page did not render for the fetch, so a stated price of zero on it is _unverified_.

Gmail and MX: "Cloud Identity Free and Premium provide identity management without Workspace Gmail inbox hosting" ([set up Cloud Identity][ci-setup]), and the Free edition is meant for users who do not need Workspace services such as Gmail ([editions][ci-editions]). The one mail requirement is for the administrator address: "To receive system notifications (such as Google Cloud project migration invitations), the customer's domain must have an active external email service or mail forwarding configured for their administrator email address" ([set up Cloud Identity][ci-setup]). Google's page on setting up email says MX records come from "your email host provider" and lists forwarding an address to another account as an option ([set up email with your domain][ci-email]). A Cloudflare Email Routing rule for `admin@cup.audio` is such forwarding. Whether sign-up mails a confirmation to `admin@cup.audio` before it continues is _unverified_; adding the rule first covers it either way.

## Domain verification

The TXT record has type `TXT`, host `@` (or blank), and the value copied from the Admin console, including the prefix, such as `google-site-verification=abcdef123_456wx789yz`; recognition can take up to 72 hours ([verify your domain with a TXT record][txt-record]). In Terraform that is a `cloudflare_dns_record` of type `TXT` on `cup.audio`, quoted like the existing DMARC record.

A CNAME alternative exists: Google's help says a CNAME record may be needed "to either verify your domain or reset your administrator password", with a unique label and a destination ending in `.domainverify.googlehosted.com` ([add a CNAME record][cname-record]). The Cloud Identity verification guide itself describes only TXT ([verify your domain][ci-verify]), so TXT is the documented route.

After verification: "Once verified, the TXT record can be safely removed", and "Removing it before Google verifies ownership will cause the verification to fail" ([verify your domain with a TXT record][txt-record]). Keeping it costs nothing and Google's admin recovery wizard relies on proving DNS ownership of the domain ([admin account best practices][admin-best-practices]), so keeping the record in Terraform is the conservative choice; that Google ever re-checks the record is _unverified_.

When the token is shown: the verification guide has the administrator open Admin console → Account → Domains → Manage domains → Verify domain and follow the setup tool, so the token appears after the account exists ([verify your domain][ci-verify]). Terraform can therefore add the record only after the operator signs up. That the value is unique per Cloud Identity account, so it cannot be known earlier, is an inference from "your unique ID, copied from the Google Admin console" ([verify your domain with a TXT record][txt-record]).

## Google Groups on the domain

Cloud Identity Free includes "Manage groups for your organization" and "Groups for Business" ([editions][ci-editions]). An administrator creates a group in Admin console → Directory → Groups with a group name, a group email such as `support@cup.audio`, and optional owners, then chooses an access type and the access settings "Who can contact group owners", "Who can view conversations", "Who can post", "Who can view members" and "Who can join the group" ([create a group][create-group]). The create-group and sharing-settings pages do not mention Cloud Identity by name; that every setting below appears in a Cloud Identity Free Admin console is _unverified_ in detail.

External members are controlled at two levels. Organization-wide, Admin console → Apps → Google Workspace → Groups for Business → Sharing settings has "Group owners can allow external members" and "Group owners can allow incoming email from outside the organization", both unchecked (not allowed) by default; this page "Requires turning on Groups for Business" ([organization-wide policies for groups][groups-policies]). Per group, the setting is "Allow external members in the group" ([create a group][create-group]). Google announced stricter classifications from Q2 2026: groups with external members off are internal and "will only allow internal users to be members", and for external groups only group admins can add external members ([internal and external classifications][groups-classification]). Whether Groups for Business is on by default in a new Cloud Identity Free account is _unverified_.

Roles: owners have all permissions; managers can do everything owners can except delete the group, make another member an owner, and change an owner's role or subscription settings ([assign roles][group-roles]). Google does not say whether an external member can be an owner or manager; the role page only rules out a group as owner or manager of another group ([assign roles][group-roles]), so an external manager or owner is _unverified_.

## User support email on the Branding page

Google's rule, on [Manage OAuth App Branding][branding]: the user support email must be either the address of a Google Group "managed by the currently logged-in user", which Workspace users may create in their organization first, or "the email address of the currently logged-in user, which must be registered as a Google account". For a non-Gmail address, Google says to sign in with the Workspace account, or to register the address as a Google account, "make that account a project editor or owner", and sign in with it so it appears in the dropdown ([manage OAuth app branding][branding]). Apps Script's verification guide words the group case as "a Google Group that you own or manage" ([OAuth client verification][apps-script-verification]).

Owner versus manager: the console help says "managed"; the Apps Script guide says "own or manage". The shut-down IAP OAuth Admin API was stricter: "The user issuing the request must be an owner of the specified support email address", where the address could be a Google Groups alias ([programmatic OAuth clients][iap-programmatic]). That API was shut down on March 19, 2026 ([programmatic OAuth clients][iap-programmatic]). Whether the console accepts a manager who is not an owner is _unverified_, which is why the recommended setup makes the signed-in account the group's owner.

Consumer account outside the domain, project outside the Organization: no Google page says whether the dropdown lists a `cup.audio` group to a consumer account that manages it, or whether the project's lack of an Organization matters. Both are _unverified_. The configuration that matches Google's documented workaround is to sign in as the `cup.audio` account that owns the group, with Editor or Owner on `cup-production`.

## Organization resource

Signing up for Cloud Identity creates the Cloud Identity account ("Your Cloud Identity organization is created after you finish your signup and setup steps") ([set up Cloud Identity][ci-setup]). The Google Cloud Organization resource follows from Google Cloud use: for new users, "the organization resource will be created for you when you log in to the Google Cloud console and accept the terms and conditions"; existing users get it when they create a project or billing account ([creating and managing organizations][org-create]). Step 7 of the sequence, signing in to the console as `admin@cup.audio`, will therefore most likely create it.

Side effects ([creating and managing organizations][org-create]):

- The super admin who creates the Organization is assigned Organization Administrator; Google recommends delegating that role.
- "All users in your domain are automatically granted Project Creator" and Billing Account Creator at the organization level.
- Existing projects stay outside: "Any projects you created previously will be listed under "No organization", and this is normal", and moving them is a manual migration. `cup-production` is owned by the operator's consumer account, not a `cup.audio` account, so nothing moves it.

Organizations created on or after May 3, 2024 get the Google Cloud security baseline policies enforced at creation: no service account key creation or upload, no automatic Editor grant to default service accounts, restricted identities by domain (`iam.allowedPolicyMemberDomains`), restricted Essential Contacts domains, internal-only protocol forwarding, and uniform bucket-level access ([secure by default organizations][secure-by-default]). They apply to projects inside the Organization; `cup-production` is outside it, so granting the consumer account or `admin@cup.audio` roles on it is unaffected. A new project created later by a `cup.audio` account would land in the Organization under these policies.

## Existing accounts with `cup.audio` addresses

"When you add and verify a domain", "any consumer account that uses an email address with this domain becomes an unmanaged account"; "For the user, this has no impact; they can sign in and access their data as normal", and within about 12 hours such accounts appear in the transfer tool for unmanaged users ([migrating consumer accounts][migrate-consumer]). If an administrator then creates a managed account with the same address, "this new account, together with the unmanaged account, becomes a conflicting account" ([migrating consumer accounts][migrate-consumer]). The transfer tool is the place to check after verification.

A group cannot share an address with a user: adding or updating a user or group "with an email address that already belongs to an existing user or group in your organization" produces a conflicting account ([duplicate account conflicts][duplicate-conflicts]). `admin@cup.audio` as a user and `support@cup.audio` as a group do not collide. Whether an unmanaged consumer account `support@cup.audio`, outside the organization, blocks creating the group is _unverified_; the transfer-tool check covers it.

## Mail to the group

Nothing in Cloud Identity requires changing MX: Cloud Identity provides identity "without Workspace Gmail inbox hosting", and only the administrator address needs mail service or forwarding ([set up Cloud Identity][ci-setup]). MX records decide where the domain's mail goes ([set up email with your domain][ci-email]), so mail to `support@cup.audio` keeps reaching Cloudflare Email Routing and the operator, and the Google group receives none. Google itself suggests not creating MX records for domains whose groups "aren't intended for communication" ([best practices for Google groups][iam-groups]).

Settings worth tightening on a group that never receives mail: set "Who can post" and "Who can view conversations" to the group's owners, "Who can join the group" to invited users only, and leave external members and incoming email from outside the organization off ([create a group][create-group], [organization-wide policies for groups][groups-policies]). With MX on Cloudflare these settings change nothing in practice; they only keep the group closed if mail ever reached Google.

## Securing the super admin

Google's recommendations ([security best practices for administrator accounts][admin-best-practices]):

- "Require 2-Step Verification for admin accounts", preferably security keys, which "are the most secure form of 2SV"; enroll more than one key.
- "Super administrators should use a separate, non-admin account for day-to-day activities", and sign in only for specific tasks, then sign out.
- "Your organization should have more than one super administrator account, each managed by a separate individual." Cup has one operator, so this cannot be met with two people; a second super admin held by the same person is a recovery measure, not separation.
- "Admins should add recovery options to their admin account": a recovery phone and email, plus printed backup codes stored securely. For most new customers, super admin self-recovery is off by default; Google also offers a recovery wizard that checks DNS ownership of the domain.
- Set admin email alerts for suspicious sign-ins and review the Admin log.

## Sources

- [Set up Cloud Identity as a Google Cloud admin][ci-setup], sign-up steps, Gmail, the administrator address's mail requirement.
- [Cloud Identity Free sign-up][ci-signup].
- [Editions][ci-editions] and [How licensing works for Cloud Identity][ci-licensing], features, groups, user cap.
- [Verifying your domain][ci-verify], [Verify your domain with a TXT record][txt-record] and [Add a CNAME record][cname-record].
- [Set up email with your domain][ci-email].
- [Create a group in your organization][create-group], [Set organization-wide policies for using groups][groups-policies], [Changes to internal and external classifications in Google Groups][groups-classification] and [Assign roles to a group's members][group-roles].
- [Manage OAuth App Branding][branding], [OAuth Client Verification (Apps Script)][apps-script-verification] and [Programmatically creating OAuth clients for IAP][iap-programmatic].
- [Creating and managing organization resources][org-create] and [Secure by default organizations][secure-by-default].
- [Migrate consumer accounts][migrate-consumer] and [Resolve duplicate account conflicts][duplicate-conflicts].
- [Best practices for using Google groups][iam-groups].
- [Security best practices for administrator accounts][admin-best-practices].

[ci-setup]: https://docs.cloud.google.com/identity/docs/set-up-cloud-identity-admin
[ci-signup]: https://workspace.google.com/gcpidentity/signup?sku=identitybasic
[ci-editions]: https://docs.cloud.google.com/identity/docs/editions
[ci-licensing]: https://docs.cloud.google.com/identity/docs/how-to/how-licensing-works-for-cloud-identity
[ci-verify]: https://docs.cloud.google.com/identity/docs/how-to/verify-domain
[ci-email]: https://docs.cloud.google.com/identity/docs/how-to/set-up-email-with-your-domain
[txt-record]: https://knowledge.workspace.google.com/admin/domains/verify-your-domain-with-a-txt-record
[cname-record]: https://knowledge.workspace.google.com/admin/domains/add-a-cname-record-to-your-domains-dns-records
[create-group]: https://knowledge.workspace.google.com/admin/groups/create-a-group-in-your-organization
[groups-policies]: https://knowledge.workspace.google.com/admin/groups/set-organization-wide-policies-for-using-groups
[groups-classification]: https://knowledge.workspace.google.com/admin/groups/changes-to-internal-and-external-classifications-in-google-groups
[group-roles]: https://knowledge.workspace.google.com/admin/groups/assign-roles-to-a-groups-members
[branding]: https://support.google.com/cloud/answer/15549049
[apps-script-verification]: https://developers.google.com/apps-script/guides/client-verification
[iap-programmatic]: https://docs.cloud.google.com/iap/docs/programmatic-oauth-clients
[org-create]: https://docs.cloud.google.com/resource-manager/docs/creating-managing-organization
[secure-by-default]: https://docs.cloud.google.com/resource-manager/docs/secure-by-default-organizations
[migrate-consumer]: https://docs.cloud.google.com/architecture/identity/migrating-consumer-accounts
[duplicate-conflicts]: https://knowledge.workspace.google.com/admin/support/troubleshooting/username-already-exists
[iam-groups]: https://docs.cloud.google.com/iam/docs/groups-best-practices
[admin-best-practices]: https://knowledge.workspace.google.com/admin/users/security-best-practices-for-administrator-accounts

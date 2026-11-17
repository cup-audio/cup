# Reads CLOUDFLARE_API_TOKEN from the environment; see terraform/README.md for its permissions.
provider "cloudflare" {}

locals {
  cloudflare_account_id = "a7648178b6a63bb8a13f0c9de89d253f"

  # Zone IDs rather than lookups, so plans need no zone-wide read beyond the records managed here.
  cup_audio_zone_id     = "c8e20cc4a39dd016799943a156ea9470"
  cup_audio_com_zone_id = "8a1d2447e703110aa6ecd2bf4c61bc30"
}

# The Worker's AUDIO_BUCKET binding; holds every listener's narration audio.
resource "cloudflare_r2_bucket" "audio" {
  account_id    = local.cloudflare_account_id
  name          = "create-audiobook-from-url-audio"
  jurisdiction  = "default"
  location      = "eeur"
  storage_class = "Standard"

  lifecycle {
    prevent_destroy = true
  }
}

# DNS records. The proxied AAAA records for the Worker's custom domains belong to Wrangler and stay
# out of Terraform.

# Resend sending records for cup.audio; they must match the domain's records in the Resend dashboard.
resource "cloudflare_dns_record" "cup_audio_resend_dkim" {
  zone_id = local.cup_audio_zone_id
  name    = "resend._domainkey.cup.audio"
  type    = "TXT"
  content = "\"p=MIGfMA0GCSqGSIb3DQEBAQUAA4GNADCBiQKBgQDBW8CvhBodv2+z1TApvFfdbdNsgq0buAtD0wOwjS8d+eiqpREarx0YNFm4NlyURBoMEiEYQFrl8b9TLbK15fV/KNlQVTmVSTVrrTlYR/jhj/S5YdiPsjFrkanrUwYI6CyjdSl79jrW554+yuLQMwCwLfLHFZz7rhzpvjeY6VSruwIDAQAB\""
  ttl     = 3600
}

resource "cloudflare_dns_record" "cup_audio_resend_send" {
  zone_id = local.cup_audio_zone_id
  name    = "send.cup.audio"
  type    = "CNAME"
  content = "send.forge.rmta.net"
  proxied = false
  ttl     = 3600
}

resource "cloudflare_dns_record" "cup_audio_resend_return_path" {
  zone_id = local.cup_audio_zone_id
  name    = "rsend.cup.audio"
  type    = "CNAME"
  content = "rsend-euw1.forge.rmta.net"
  proxied = false
  ttl     = 1
}

# cup.audio receives mail through Email Routing below, which adds and locks its own MX and SPF
# records, so they stay out of Terraform. Neither domain's SPF authorizes Resend: it signs with DKIM,
# which DMARC accepts.
resource "cloudflare_dns_record" "cup_audio_dmarc" {
  zone_id = local.cup_audio_zone_id
  name    = "_dmarc.cup.audio"
  type    = "TXT"
  content = "\"v=DMARC1; p=reject; sp=reject\""
  ttl     = 1
}

# cup-audio.com receives no mail and authorizes no sender through SPF.
resource "cloudflare_dns_record" "cup_audio_com_null_mx" {
  zone_id  = local.cup_audio_com_zone_id
  name     = "cup-audio.com"
  type     = "MX"
  content  = "."
  priority = 0
  ttl      = 1
}

resource "cloudflare_dns_record" "cup_audio_com_spf" {
  zone_id = local.cup_audio_com_zone_id
  name    = "cup-audio.com"
  type    = "TXT"
  content = "\"v=spf1 -all\""
  ttl     = 1
}

resource "cloudflare_dns_record" "cup_audio_com_dmarc" {
  zone_id = local.cup_audio_com_zone_id
  name    = "_dmarc.cup-audio.com"
  type    = "TXT"
  content = "\"v=DMARC1; p=reject; sp=reject\""
  ttl     = 1
}

# Email Routing on cup.audio forwards support@cup.audio, the Google Play developer email, and
# github@cup.audio, the contact email of the cup-audio GitHub organization, to the operator.
# Enabling it adds and locks Cloudflare's MX, SPF and DKIM records on the zone. With no catch-all
# rule, mail to any other address is rejected.
resource "cloudflare_email_routing_dns" "cup_audio" {
  zone_id = local.cup_audio_zone_id
}

# The operator's private inbox that both addresses forward to. Cloudflare sends it a verification
# link that must be clicked once before the rules forward anything.
variable "support_email_destination" {
  type      = string
  sensitive = true

  validation {
    condition     = can(regex("^[^@\\s]+@[^@\\s]+$", var.support_email_destination))
    error_message = "Provide the operator's private email address that support@cup.audio and github@cup.audio forward to."
  }
}

resource "cloudflare_email_routing_address" "operator" {
  account_id = local.cloudflare_account_id
  email      = var.support_email_destination
}

resource "cloudflare_email_routing_rule" "support" {
  zone_id = local.cup_audio_zone_id
  name    = "support@cup.audio to the operator"
  enabled = true
  matchers = [
    {
      type  = "literal"
      field = "to"
      value = "support@cup.audio"
    },
  ]
  actions = [
    {
      type  = "forward"
      value = [cloudflare_email_routing_address.operator.email]
    },
  ]

  depends_on = [cloudflare_email_routing_dns.cup_audio]
}

resource "cloudflare_email_routing_rule" "github" {
  zone_id = local.cup_audio_zone_id
  name    = "github@cup.audio to the operator"
  enabled = true
  matchers = [
    {
      type  = "literal"
      field = "to"
      value = "github@cup.audio"
    },
  ]
  actions = [
    {
      type  = "forward"
      value = [cloudflare_email_routing_address.operator.email]
    },
  ]

  depends_on = [cloudflare_email_routing_dns.cup_audio]
}

# Cloudflare Access in front of the operator API. The Worker validates the Access JWT against
# OPERATOR_ACCESS_AUDIENCE and OPERATOR_EMAIL in apps/cloudflare-worker/wrangler.jsonc.
resource "cloudflare_zero_trust_access_policy" "allow_operator" {
  account_id = local.cloudflare_account_id
  name       = "Allow Patrick"
  decision   = "allow"
  connection_rules = {
    rdp = {}
  }
  include = [
    {
      email = {
        email = "patrick.kerschbaum@gmail.com"
      }
    },
  ]
}

resource "cloudflare_zero_trust_access_application" "operator_api" {
  account_id                 = local.cloudflare_account_id
  name                       = "Create Audiobook from URL operator API"
  type                       = "self_hosted"
  domain                     = "cup.audio/api/operator/*"
  session_duration           = "24h"
  app_launcher_visible       = true
  auto_redirect_to_identity  = false
  enable_binding_cookie      = false
  http_only_cookie_attribute = false
  options_preflight_bypass   = false
  destinations = [
    {
      type = "public"
      uri  = "cup.audio/api/operator/*"
    },
  ]
  policies = [
    {
      id         = cloudflare_zero_trust_access_policy.allow_operator.id
      precedence = 1
    },
  ]
}

output "operator_access_audience" {
  description = "The Access application's AUD tag; must equal OPERATOR_ACCESS_AUDIENCE in the Worker configuration."
  value       = cloudflare_zero_trust_access_application.operator_api.aud
}

# The AI Gateway that narration content selection and speech synthesis call, in development and
# production alike. The Google AI Studio key it uses lives in its key store and is not managed here.
resource "cloudflare_ai_gateway" "default" {
  account_id                 = local.cloudflare_account_id
  id                         = "default"
  authentication             = true
  cache_invalidate_on_update = false
  cache_ttl                  = 0
  collect_logs               = true
  log_management             = 100000
  log_management_strategy    = "DELETE_OLDEST"

  # The provider requires a rate limit, but Cup wants none from the gateway: Google limits the
  # project (1,000 requests per minute for speech on 2026-10-11, ADR 0008) and the application waits
  # out its rejections. This ceiling is ten times that limit, so Google's always applies first.
  rate_limiting_interval  = 60
  rate_limiting_limit     = 10000
  rate_limiting_technique = "sliding"

  # Caps runaway cost: 30 USD per rolling 30 days.
  spend_limits = {
    enabled = true
    rules = [
      {
        id         = "8ff62c21"
        enabled    = true
        limit_type = "cost"
        limit      = 30
        technique  = "sliding"
        window     = 2592000
      },
    ]
  }

  lifecycle {
    prevent_destroy = true
  }
}

terraform {
  required_version = ">= 1.10.0, < 2.0.0"

  backend "gcs" {
    bucket = "cup-infrastructure-646301813623-tfstate"
    prefix = "sentry"
  }

  required_providers {
    sentry = {
      source  = "jianyuan/sentry"
      version = "0.16.0"
    }
    http = {
      source  = "hashicorp/http"
      version = "~> 3.5"
    }
  }
}

# The privacy settings in privacy.tf read the organisation and project through this token. Pass the
# same value the provider reads from SENTRY_AUTH_TOKEN; terraform/README.md#sentry shows how.
variable "sentry_auth_token" {
  type      = string
  sensitive = true
}

# Reads SENTRY_AUTH_TOKEN from the environment; see terraform/README.md#sentry for its scopes.
provider "sentry" {
  base_url = local.sentry_api_base_url
}

locals {
  # The organisation lives in Sentry's Germany region, so every API call goes to de.sentry.io.
  sentry_api_base_url = "https://de.sentry.io/api/"

  # The operator creates the organisation with this slug in the Sentry UI.
  organization_slug = "cupaudio"
}

# Created by the operator in the UI (free Developer plan, Germany region) and only read here, never
# imported, so no plan can change or delete it. Its privacy settings are set in privacy.tf.
data "sentry_organization" "cup" {
  slug = local.organization_slug
}

resource "sentry_team" "cup" {
  organization = data.sentry_organization.cup.slug
  name         = "Cup"
  slug         = "cup"
}

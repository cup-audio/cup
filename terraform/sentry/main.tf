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

variable "sentry_auth_token" {
  type      = string
  sensitive = true
}

provider "sentry" {
  base_url = local.sentry_api_base_url
}

locals {
  sentry_api_base_url = "https://de.sentry.io/api/"

  organization_slug = "cupaudio"
}

data "sentry_organization" "cup" {
  slug = local.organization_slug
}

resource "sentry_team" "cup" {
  organization = data.sentry_organization.cup.slug
  name         = "Cup"
  slug         = "cup"
}

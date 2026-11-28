terraform {
  required_version = ">= 1.10.0, < 2.0.0"

  backend "gcs" {
    bucket = "cup-infrastructure-646301813623-tfstate"
    prefix = "apple-client-secret"
  }

  required_providers {
    supabase = {
      source  = "supabase/supabase"
      version = "1.11.0"
    }
  }
}

provider "supabase" {}

variable "apple_client_secret" {
  type      = string
  sensitive = true

  validation {
    condition     = length(split(".", var.apple_client_secret)) == 3
    error_message = "Provide the Apple client secret as a signed JWT; sign it with tooling/apple-client-secret."
  }
}

locals {
  supabase_project_ref = "evwjipxgacwotgbmqtla"
}

resource "supabase_settings" "apple_client_secret" {
  project_ref = local.supabase_project_ref
  auth = jsonencode({
    external_apple_secret = var.apple_client_secret
  })
}

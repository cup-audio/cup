# The provider cannot set the organisation's privacy settings or a project's Advanced Data Scrubbing
# rules, so these resources send them to Sentry's API whenever the committed JSON changes. Each PUT
# replaces every rule of its scope, so rules added in the UI are lost on the next change here. The
# check blocks compare the live values in every plan, which catches such UI edits.

locals {
  organization_api_url = "${local.sentry_api_base_url}0/organizations/${data.sentry_organization.cup.slug}/"
  cup_worker_api_url   = "${local.sentry_api_base_url}0/projects/${data.sentry_organization.cup.slug}/${sentry_project.cup["worker"].slug}/"

  organization_relay_pii_config = jsondecode(file("${path.module}/privacy/organization-relay-pii-config.json"))
  cup_worker_relay_pii_config   = jsondecode(file("${path.module}/privacy/cup-worker-relay-pii-config.json"))

  organization_privacy_settings = jsonencode({
    scrubIPAddresses = true
    relayPiiConfig   = jsonencode(local.organization_relay_pii_config)
  })
  cup_worker_privacy_settings = jsonencode({
    relayPiiConfig = jsonencode(local.cup_worker_relay_pii_config)
  })

  # Reads SENTRY_AUTH_TOKEN from the environment Terraform runs in, so the token stays out of state.
  put_privacy_settings_command = <<-EOT
    printf '%s' "$${PRIVACY_SETTINGS}" | curl --silent --show-error --fail \
      --request PUT \
      --header "Authorization: Bearer $${SENTRY_AUTH_TOKEN}" \
      --header "Content-Type: application/json" \
      --data-binary @- \
      "$${API_URL}" > /dev/null
  EOT
}

resource "terraform_data" "organization_privacy_settings" {
  triggers_replace = {
    api_url           = local.organization_api_url
    settings_checksum = sha256(local.organization_privacy_settings)
  }

  provisioner "local-exec" {
    command = local.put_privacy_settings_command
    environment = {
      API_URL          = local.organization_api_url
      PRIVACY_SETTINGS = local.organization_privacy_settings
    }
  }
}

resource "terraform_data" "cup_worker_privacy_settings" {
  triggers_replace = {
    api_url           = local.cup_worker_api_url
    settings_checksum = sha256(local.cup_worker_privacy_settings)
  }

  provisioner "local-exec" {
    command = local.put_privacy_settings_command
    environment = {
      API_URL          = local.cup_worker_api_url
      PRIVACY_SETTINGS = local.cup_worker_privacy_settings
    }
  }
}

# The token passed in request_headers is written to state; this is accepted, as state already holds
# the Sentry keys and is access-controlled.
check "organization_privacy_settings" {
  data "http" "organization" {
    url = local.organization_api_url
    request_headers = {
      Authorization = "Bearer ${var.sentry_auth_token}"
    }
  }

  assert {
    condition     = data.http.organization.status_code == 200
    error_message = "Reading the Sentry organisation returned HTTP ${data.http.organization.status_code}."
  }

  assert {
    condition     = try(jsondecode(data.http.organization.response_body).scrubIPAddresses, null) == true
    error_message = "The Sentry organisation stores IP addresses; apply this root to turn \"Prevent storing IP addresses\" back on."
  }

  assert {
    condition     = try(jsondecode(jsondecode(data.http.organization.response_body).relayPiiConfig), null) == local.organization_relay_pii_config
    error_message = "The Sentry organisation's Advanced Data Scrubbing rules differ from privacy/organization-relay-pii-config.json; fold any wanted UI change into the file, then apply."
  }
}

check "cup_worker_privacy_settings" {
  data "http" "cup_worker" {
    url = local.cup_worker_api_url
    request_headers = {
      Authorization = "Bearer ${var.sentry_auth_token}"
    }
  }

  assert {
    condition     = data.http.cup_worker.status_code == 200
    error_message = "Reading the Sentry project cup-worker returned HTTP ${data.http.cup_worker.status_code}."
  }

  assert {
    condition     = try(jsondecode(jsondecode(data.http.cup_worker.response_body).relayPiiConfig), null) == local.cup_worker_relay_pii_config
    error_message = "The Advanced Data Scrubbing rules of cup-worker differ from privacy/cup-worker-relay-pii-config.json; fold any wanted UI change into the file, then apply."
  }
}

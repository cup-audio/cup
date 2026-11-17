locals {
  # `cup-worker` receives the Worker's events, `cup-app` those of the web app and both shells.
  projects = {
    worker = {
      name     = "cup-worker"
      platform = "node-cloudflare-workers"
    }
    app = {
      name     = "cup-app"
      platform = "capacitor"
    }
  }

  # Inbound filters drop junk at ingest, before it counts against the quota.
  toggled_inbound_filters = ["browser-extensions", "web-crawlers", "localhost"]

  # Every legacy-browser subfilter Sentry has not deprecated; each filters that browser's old versions.
  legacy_browser_subfilters = ["android", "chrome", "edge", "firefox", "ie", "opera", "opera_mini", "safari"]

  project_inbound_filters = {
    for pair in setproduct(keys(local.projects), local.toggled_inbound_filters) :
    "${pair[0]}-${pair[1]}" => {
      project   = pair[0]
      filter_id = pair[1]
    }
  }
}

resource "sentry_project" "cup" {
  for_each = local.projects

  organization = data.sentry_organization.cup.slug
  teams        = [sentry_team.cup.slug]
  name         = each.value.name
  slug         = each.value.name
  platform     = each.value.platform

  # The single key per project is the `sentry_key` below.
  default_key = false
  # Alert rules come from Terraform only, so Sentry's default "every new issue" rule stays off.
  default_rules = false
}

# The DSNs of these keys are compiled into `@cup/telemetry.core`. Replacing a key changes its DSN
# and silences every client that still sends to the old one.
resource "sentry_key" "cup" {
  for_each = local.projects

  organization = data.sentry_organization.cup.slug
  project      = sentry_project.cup[each.key].slug
  name         = each.value.name

  lifecycle {
    prevent_destroy = true
  }
}

resource "sentry_project_inbound_data_filter" "toggled" {
  for_each = local.project_inbound_filters

  organization = data.sentry_organization.cup.slug
  project      = sentry_project.cup[each.value.project].slug
  filter_id    = each.value.filter_id
  active       = true
}

resource "sentry_project_inbound_data_filter" "legacy_browsers" {
  for_each = local.projects

  organization = data.sentry_organization.cup.slug
  project      = sentry_project.cup[each.key].slug
  filter_id    = "legacy-browsers"
  subfilters   = local.legacy_browser_subfilters
}

resource "sentry_project_spike_protection" "cup" {
  for_each = local.projects

  organization = data.sentry_organization.cup.slug
  project      = sentry_project.cup[each.key].slug
  enabled      = true
}

# Sends Sentry's own notification, an email, when spike protection starts dropping events.
resource "sentry_notification_action" "spike_protection" {
  # Sentry accepts one project per spike-protection action.
  for_each = local.projects

  organization = data.sentry_organization.cup.slug
  projects     = [sentry_project.cup[each.key].slug]
  trigger_type = "spike-protection"
  service_type = "sentry_notification"
  # Sentry accepts only this one target for its own notification.
  target_identifier = "default"
  target_display    = "default"
}

# Public by design: a DSN only lets a client send events. Copy each into `@cup/telemetry.core`.
output "cup_worker_dsn" {
  value = nonsensitive(sentry_key.cup["worker"].dsn["public"])
}

output "cup_app_dsn" {
  value = nonsensitive(sentry_key.cup["app"].dsn["public"])
}

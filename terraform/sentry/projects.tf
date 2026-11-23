locals {
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

  toggled_inbound_filters = ["browser-extensions", "web-crawlers", "localhost"]

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

  default_key = false
  default_rules = false
}

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

resource "sentry_notification_action" "spike_protection" {
  for_each = local.projects

  organization = data.sentry_organization.cup.slug
  projects     = [sentry_project.cup[each.key].slug]
  trigger_type = "spike-protection"
  service_type = "sentry_notification"
  target_identifier = "default"
  target_display    = "default"
}

output "cup_worker_dsn" {
  value = nonsensitive(sentry_key.cup["worker"].dsn["public"])
}

output "cup_app_dsn" {
  value = nonsensitive(sentry_key.cup["app"].dsn["public"])
}

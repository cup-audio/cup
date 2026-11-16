# The alerts are the operator's only source of Sentry email: personal workflow notifications are off
# (see terraform/README.md#personal-notifications). Each alert emails the team `cup`, so its
# members, at most once an hour per issue.

locals {
  # Sentry's free Developer plan holds 5k errors and 5M spans a month. A monitor fires at about a
  # thirtieth of each, a day's share, so the operator learns before a quota runs out mid-month.
  daily_error_quota_share = 150
  daily_span_quota_share  = 165000

  alert_frequency_minutes = 60

  email_team = {
    target_type = "team"
    target_id   = sentry_team.cup.internal_id
  }
}

# Sentry creates these default monitors with each project. The issue stream monitor tracks every new
# issue of the project, of every type, native crashes, ANRs and app hangs in `cup-app` included.
data "sentry_project_issue_stream_monitor" "cup" {
  for_each = local.projects

  organization = data.sentry_organization.cup.slug
  project      = sentry_project.cup[each.key].slug
}

data "sentry_project_error_monitor" "cup" {
  for_each = local.projects

  organization = data.sentry_organization.cup.slug
  project      = sentry_project.cup[each.key].slug
}

# Shares the free plan's single uptime monitor. The Worker drops the traces of these checks.
resource "sentry_uptime_monitor" "health" {
  organization = data.sentry_organization.cup.slug
  project      = sentry_project.cup["worker"].slug
  name         = "GET /api/health"
  description  = "The Worker answers 200 on its shallow health route while it runs; the route calls no Supabase, Durable Object or AI service."
  environment  = "production"

  owner = {
    team_id = sentry_team.cup.internal_id
  }

  url                = "https://cup.audio/api/health"
  method             = "GET"
  interval_seconds   = 60
  timeout_ms         = 10000
  downtime_threshold = 3
  recovery_threshold = 1

  assertion_json = provider::sentry::assertion(
    provider::sentry::op_status_code_check("equals", 200),
  )
}

resource "sentry_metric_monitor" "daily_errors" {
  for_each = local.projects

  organization = data.sentry_organization.cup.slug
  project      = sentry_project.cup[each.key].slug
  name         = "${each.value.name}: more than ${local.daily_error_quota_share} errors a day"
  description  = "Error volume heads past the free plan's monthly error quota. Find the source on the Stats page; see docs/architecture/observability.md#alerts-and-monitors."

  owner = {
    team_id = sentry_team.cup.internal_id
  }

  # Error and default (message) events both count against the error quota.
  dataset             = "events"
  event_types         = ["error", "default"]
  query_type          = "error"
  aggregate           = "count()"
  query               = ""
  time_window_seconds = 86400

  issue_detection = {
    type = "static"
  }

  condition_group = {
    conditions = [
      {
        type             = "gt"
        comparison       = local.daily_error_quota_share
        condition_result = 75
      },
      {
        type             = "lte"
        comparison       = local.daily_error_quota_share
        condition_result = 0
      },
    ]
  }
}

resource "sentry_metric_monitor" "daily_spans" {
  for_each = local.projects

  organization = data.sentry_organization.cup.slug
  project      = sentry_project.cup[each.key].slug
  name         = "${each.value.name}: more than ${local.daily_span_quota_share} spans a day"
  description  = "Span volume heads past the free plan's monthly span quota. Find the source on the Stats page; see docs/architecture/observability.md#alerts-and-monitors."

  owner = {
    team_id = sentry_team.cup.internal_id
  }

  dataset             = "events_analytics_platform"
  event_types         = ["trace_item_span"]
  query_type          = "performance"
  aggregate           = "count(span.duration)"
  query               = ""
  time_window_seconds = 86400

  issue_detection = {
    type = "static"
  }

  condition_group = {
    conditions = [
      {
        type             = "gt"
        comparison       = local.daily_span_quota_share
        condition_result = 75
      },
      {
        type             = "lte"
        comparison       = local.daily_span_quota_share
        condition_result = 0
      },
    ]
  }
}

# Emails when a project gets a new issue or a resolved one comes back: server, client and native
# crash issues, the stuck checks' issues, and the issues of the project's uptime and metric monitors.
resource "sentry_alert" "new_or_regressed_issue" {
  for_each = local.projects

  organization      = data.sentry_organization.cup.slug
  name              = "${each.value.name}: new or regressed issue"
  frequency_minutes = local.alert_frequency_minutes

  monitor_ids = concat(
    [
      data.sentry_project_issue_stream_monitor.cup[each.key].id,
      sentry_metric_monitor.daily_errors[each.key].id,
      sentry_metric_monitor.daily_spans[each.key].id,
    ],
    each.key == "worker" ? [sentry_uptime_monitor.health.id] : [],
  )

  trigger_conditions = [
    { first_seen_event = {} },
    { regression_event = {} },
  ]

  action_filters = [
    {
      logic_type = "all"
      conditions = []
      actions    = [{ email = local.email_team }]
    },
  ]
}

# Emails when one conversion-failure issue, an error tagged with its failure category, is seen more
# than 5 times in an hour, so a burst stands out from a single failure. Only the Worker captures
# conversion failures.
resource "sentry_alert" "conversion_failure_frequency" {
  organization      = data.sentry_organization.cup.slug
  name              = "cup-worker: conversion failure seen more than 5 times in 1 h"
  frequency_minutes = local.alert_frequency_minutes

  monitor_ids = [data.sentry_project_error_monitor.cup["worker"].id]

  # No trigger condition: every event of an issue is evaluated against the filters below.
  trigger_conditions = []

  action_filters = [
    {
      logic_type = "all"
      conditions = [
        {
          tagged_event = {
            key   = "cup.conversion.failure_category"
            match = "is"
          }
        },
        {
          event_frequency_count = {
            interval = "1h"
            value    = 5
          }
        },
      ]
      actions = [{ email = local.email_team }]
    },
  ]
}

# Scripted uploads to Google Play. The release command impersonates the uploader service account
# through the operator's application-default credentials, so no service account key exists. Inviting
# the account in the Play Console is manual; see docs/production-configuration.md.

# Creating a service account needs the IAM API and minting its tokens needs the IAM Service Account
# Credentials API; neither was enabled in cup-production on 2026-11-16.
resource "google_project_service" "production" {
  for_each = toset([
    "androidpublisher.googleapis.com",
    "iam.googleapis.com",
    "iamcredentials.googleapis.com",
  ])

  project            = google_project.production.project_id
  service            = each.value
  disable_on_destroy = false
}

resource "google_service_account" "play_publisher" {
  project      = google_project.production.project_id
  account_id   = "play-publisher"
  display_name = "Google Play publisher"
  description  = "Uploads Android test builds to Google Play; impersonated by the operator, has no keys."

  depends_on = [google_project_service.production]
}

resource "google_service_account_iam_member" "play_publisher_operator_token_creator" {
  service_account_id = google_service_account.play_publisher.name
  role               = "roles/iam.serviceAccountTokenCreator"
  member             = "user:patrick.kerschbaum@gmail.com"
}

output "play_publisher_service_account_email" {
  description = "The uploader service account; invite it in the Play Console and impersonate it for uploads."
  value       = google_service_account.play_publisher.email
}

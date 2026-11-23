locals {
  apple_client_secret_state_prefix = "apple-client-secret"

  github_repository    = "cup-audio/cup"
  github_repository_id = "1354565822"
  github_environment   = "production"
  github_branch_ref    = "refs/heads/main"
}

resource "google_project_service" "workload_identity_federation" {
  for_each = toset([
    "iam.googleapis.com",
    "iamcredentials.googleapis.com",
    "sts.googleapis.com",
  ])

  project            = google_project.infrastructure.project_id
  service            = each.value
  disable_on_destroy = false
}

resource "google_iam_workload_identity_pool" "github" {
  project                   = google_project.infrastructure.project_id
  workload_identity_pool_id = "github"
  display_name              = "GitHub Actions"
  description               = "Workflows of ${local.github_repository}"

  depends_on = [google_project_service.workload_identity_federation]
}

resource "google_iam_workload_identity_pool_provider" "github" {
  project                            = google_project.infrastructure.project_id
  workload_identity_pool_id          = google_iam_workload_identity_pool.github.workload_identity_pool_id
  workload_identity_pool_provider_id = "github"
  display_name                       = "GitHub Actions OIDC"

  attribute_mapping = {
    "google.subject"          = "assertion.sub"
    "attribute.repository"    = "assertion.repository"
    "attribute.repository_id" = "assertion.repository_id"
    "attribute.environment"   = "assertion.environment"
    "attribute.ref"           = "assertion.ref"
  }

  attribute_condition = join(" && ", [
    "assertion.repository == '${local.github_repository}'",
    "assertion.repository_id == '${local.github_repository_id}'",
    "assertion.environment == '${local.github_environment}'",
    "assertion.ref == '${local.github_branch_ref}'",
  ])

  oidc {
    issuer_uri = "https://token.actions.githubusercontent.com"
  }
}

resource "google_service_account" "apple_client_secret_rotation" {
  project      = google_project.infrastructure.project_id
  account_id   = "apple-client-secret-rotation"
  display_name = "Apple client secret rotation"
  description  = "The GitHub Actions workflow that applies terraform/apple-client-secret"

  depends_on = [google_project_service.workload_identity_federation]
}

resource "google_service_account_iam_member" "apple_client_secret_rotation_workload_identity_user" {
  service_account_id = google_service_account.apple_client_secret_rotation.name
  role               = "roles/iam.workloadIdentityUser"
  member             = "principal://iam.googleapis.com/${google_iam_workload_identity_pool.github.name}/subject/repo:${local.github_repository}:environment:${local.github_environment}"
}

resource "google_storage_bucket_iam_member" "apple_client_secret_rotation_state" {
  bucket = google_storage_bucket.terraform_state.name
  role   = "roles/storage.objectUser"
  member = google_service_account.apple_client_secret_rotation.member

  condition {
    title       = "apple-client-secret-state-only"
    description = "Objects under the ${local.apple_client_secret_state_prefix}/ state prefix, and listing object names in the bucket"
    expression = join(" || ", [
      "resource.name.startsWith('projects/_/buckets/${google_storage_bucket.terraform_state.name}/objects/${local.apple_client_secret_state_prefix}/')",
      "resource.name == 'projects/_/buckets/${google_storage_bucket.terraform_state.name}'",
    ])
  }
}

output "github_workload_identity_provider" {
  value = google_iam_workload_identity_pool_provider.github.name
}

output "apple_client_secret_rotation_service_account" {
  value = google_service_account.apple_client_secret_rotation.email
}

# Workload Identity Federation for GitHub Actions: CI exchanges its short-lived GitHub OIDC
# token for short-lived Google credentials. No long-lived key exists anywhere.
# Created only when github_repository is set.

resource "google_iam_workload_identity_pool" "github" {
  count                     = var.github_repository == null ? 0 : 1
  workload_identity_pool_id = "${local.name_prefix}-gh"
  display_name              = "GitHub Actions (${var.environment})"
  depends_on                = [google_project_service.apis]
}

resource "google_iam_workload_identity_pool_provider" "github" {
  count                              = var.github_repository == null ? 0 : 1
  workload_identity_pool_id          = google_iam_workload_identity_pool.github[0].workload_identity_pool_id
  workload_identity_pool_provider_id = "github"
  display_name                       = "GitHub OIDC"

  attribute_mapping = {
    "google.subject"        = "assertion.sub"
    "attribute.repository"  = "assertion.repository"
    "attribute.ref"         = "assertion.ref"
    "attribute.environment" = "assertion.environment"
  }

  # Only this repository, only the approved branches, only jobs that run in the approved GitHub environment
  # (which can require a reviewer): any other token is rejected by Google.
  attribute_condition = "assertion.repository == '${var.github_repository}' && assertion.environment == '${local.github_environment}' && assertion.ref in [${join(", ", formatlist("'%s'", var.github_deploy_branches))}]"

  oidc {
    issuer_uri = "https://token.actions.githubusercontent.com"
  }
}

resource "google_service_account_iam_member" "github_impersonates_deployer" {
  count              = var.github_repository == null ? 0 : 1
  service_account_id = google_service_account.deployer.name
  role               = "roles/iam.workloadIdentityUser"
  member             = "principalSet://iam.googleapis.com/${google_iam_workload_identity_pool.github[0].name}/attribute.environment/${local.github_environment}"
}

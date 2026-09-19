locals {
  required_apis = [
    "run.googleapis.com",
    "sqladmin.googleapis.com",
    "artifactregistry.googleapis.com",
    "secretmanager.googleapis.com",
    "cloudscheduler.googleapis.com",
    "iam.googleapis.com",
    "iamcredentials.googleapis.com",
    "sts.googleapis.com",
    "identitytoolkit.googleapis.com",
    "apikeys.googleapis.com",
    "storage.googleapis.com",
    "logging.googleapis.com",
    "monitoring.googleapis.com",
    "firebase.googleapis.com",
    "firebasehosting.googleapis.com",
    "cloudresourcemanager.googleapis.com",
    "serviceusage.googleapis.com",
  ]
}

resource "google_project_service" "apis" {
  for_each           = toset(local.required_apis)
  service            = each.value
  disable_on_destroy = false

  depends_on = [terraform_data.project_guard]
}

# Budgets need the Billing Budgets API and an explicit billing account.
resource "google_project_service" "billingbudgets" {
  count              = local.budget_enabled ? 1 : 0
  service            = "billingbudgets.googleapis.com"
  disable_on_destroy = false

  depends_on = [terraform_data.project_guard]
}

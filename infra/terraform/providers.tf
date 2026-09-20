# Authentication uses Application Default Credentials -- nothing is configured here:
#   gcloud auth login
#   gcloud auth application-default login
# No credentials file, access token, service-account key or operator e-mail is ever
# placed in Terraform or in this repository. In CI, Workload Identity Federation
# supplies short-lived credentials (see .github/workflows/deploy.yml).
# user_project_override: Application Default Credentials of a user have no quota project, and Identity Platform,
# API Keys and Firebase refuse such calls. The project itself is charged for (and authorizes) the requests.
provider "google" {
  project               = var.gcp_project_id
  region                = var.gcp_region
  user_project_override = true
  billing_project       = var.gcp_project_id
}

provider "google-beta" {
  project               = var.gcp_project_id
  region                = var.gcp_region
  user_project_override = true
  billing_project       = var.gcp_project_id
}

# The Billing Budgets API needs a quota project; only the budget uses this alias.
provider "google" {
  alias                 = "billing"
  project               = var.gcp_project_id
  region                = var.gcp_region
  user_project_override = true
  billing_project       = var.gcp_project_id
}

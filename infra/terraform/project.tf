# Validate the duplicated project configuration against what Google Cloud reports, rather
# than trusting two copies of the same fact. Every other resource depends on this guard.
data "google_project" "this" {
  project_id = var.gcp_project_id
}

resource "terraform_data" "project_guard" {
  input = data.google_project.this.number

  lifecycle {
    precondition {
      condition     = data.google_project.this.number == var.gcp_project_number
      error_message = "gcp_project_number (${var.gcp_project_number}) does not match project ${var.gcp_project_id}, whose number is ${data.google_project.this.number}. Check terraform.tfvars."
    }
  }
}

locals {
  name_prefix = "hrtstocks-${var.environment}"
  # Cloud SQL IAM service-account users are named after the account e-mail without the suffix.
  app_db_user      = trimsuffix(google_service_account.app_runtime.email, ".gserviceaccount.com")
  pipeline_db_user = trimsuffix(google_service_account.pipeline_runtime.email, ".gserviceaccount.com")
  cloud_sql_conn   = var.enable_cloud_sql ? google_sql_database_instance.main[0].connection_name : ""
  db_name          = "hrtstocks"
  charts_bucket    = "${var.gcp_project_id}-${var.environment}-charts"

  # Firebase Hosting fronts Cloud Run: custom domain -> Hosting (managed TLS) -> rewrite -> Cloud Run.
  hosting_site_id    = coalesce(var.firebase_site_id, substr("${var.gcp_project_id}-${var.environment}", 0, 30))
  hosting_default    = "https://${local.hosting_site_id}.web.app"
  app_base_url       = var.custom_domain == null ? local.hosting_default : "https://${var.custom_domain}"
  allowed_origins    = distinct(concat([local.app_base_url, local.hosting_default], var.extra_allowed_origins))
  budget_enabled     = var.monthly_budget_amount_usd != null && var.gcp_billing_account_id != null
  budget_amount      = local.budget_enabled ? ceil(var.monthly_budget_amount_usd * (var.budget_currency == "USD" ? 1 : var.budget_fx_rate_per_usd)) : 0
  github_environment = coalesce(var.github_environment, var.environment)
}

# Organization-level resources are deliberately not created: gcp_organization_id is only
# recorded for future use and nothing in this configuration reads it.

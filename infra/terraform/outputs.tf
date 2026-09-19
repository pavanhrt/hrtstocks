# No account, billing or organization identifier and no credential is ever output.

output "app_url" {
  description = "Canonical application URL (the custom domain when set, otherwise the Firebase-generated URL)."
  value       = local.app_base_url
}

output "hosting_default_url" {
  description = "Firebase-generated URL: works before DNS is configured, for pre-DNS testing."
  value       = local.hosting_default
}

output "cloud_run_url" {
  description = "Raw Cloud Run URL. Serves the same authenticated app but is not an allowed origin or sign-in domain; use it only to debug Hosting."
  value       = google_cloud_run_v2_service.app.uri
}

output "artifact_registry_repository" {
  description = "Docker repository path (push app and pipeline images here)."
  value       = "${var.gcp_region}-docker.pkg.dev/${var.gcp_project_id}/${google_artifact_registry_repository.images.repository_id}"
}

output "charts_bucket" {
  value = google_storage_bucket.charts.name
}

output "cloud_sql_connection_name" {
  description = "Empty when enable_cloud_sql = false. Used with the Cloud SQL Auth Proxy to apply migrations."
  value       = local.cloud_sql_conn
}

output "grant_roles" {
  description = "Value for GRANT_ROLES when applying migrations (grants the runtime roles to the runtime identities)."
  value       = "app_web=${local.app_db_user};app_pipeline=${local.pipeline_db_user}"
}

output "service_accounts" {
  value = {
    app       = google_service_account.app_runtime.email
    pipeline  = google_service_account.pipeline_runtime.email
    scheduler = google_service_account.scheduler.email
    deployer  = google_service_account.deployer.email
  }
}

output "job_names" {
  value = local.job_names
}

output "github_workload_identity_provider" {
  description = "Set as the GCP_WORKLOAD_IDENTITY_PROVIDER repository variable for GitHub Actions."
  value       = var.github_repository == null ? null : google_iam_workload_identity_pool_provider.github[0].name
}

output "bootstrap_admin_configured" {
  description = "True when bootstrap_admin_email is set. Terraform never creates or invites a user; see docs/gcp/authentication.md."
  value       = var.bootstrap_admin_email != null
}

output "dns_records_required" {
  description = "DNS records to add at the DNS provider for the custom domain (populated after the first apply; add ONLY these, only for this host name)."
  value = var.custom_domain == null ? [] : flatten([
    for u in try(google_firebase_hosting_custom_domain.app[0].required_dns_updates, []) : [
      for d in try(u.desired, []) : [
        for r in try(d.records, []) : {
          host   = r.domain_name
          type   = r.type
          value  = r.rdata
          action = r.required_action
        }
      ]
    ]
  ])
}

output "custom_domain_state" {
  description = "Hosting's view of the custom domain (host and ownership state)."
  value = var.custom_domain == null ? null : {
    host_state      = try(google_firebase_hosting_custom_domain.app[0].host_state, null)
    ownership_state = try(google_firebase_hosting_custom_domain.app[0].ownership_state, null)
  }
}

output "firebase_web_config" {
  description = "Public web sign-in configuration for the app build (identifiers, not secrets)."
  value = {
    NEXT_PUBLIC_FIREBASE_PROJECT_ID  = var.gcp_project_id
    NEXT_PUBLIC_FIREBASE_AUTH_DOMAIN = var.custom_domain == null ? "${local.hosting_site_id}.firebaseapp.com" : var.custom_domain
    NEXT_PUBLIC_FIREBASE_API_KEY     = google_apikeys_key.web.key_string
  }
  sensitive = true
}

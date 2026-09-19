# Secret containers only. Terraform never sees FYERS values: add a version out of band, e.g.
#   printf %s "$TOKEN" | gcloud secrets versions add <name> --data-file=-
# (docs/gcp/runbooks/fyers-token.md). No secret value is ever written by Terraform, so no
# credential can end up in Terraform state.

resource "google_secret_manager_secret" "fyers_app_id" {
  secret_id = "${local.name_prefix}-fyers-app-id"
  replication {
    auto {}
  }
  depends_on = [google_project_service.apis]
}

resource "google_secret_manager_secret" "fyers_access_token" {
  secret_id = "${local.name_prefix}-fyers-access-token"
  replication {
    auto {}
  }
  depends_on = [google_project_service.apis]
}

# Pipeline jobs read the FYERS secrets.
resource "google_secret_manager_secret_iam_member" "pipeline_reads_fyers" {
  for_each = {
    app_id = google_secret_manager_secret.fyers_app_id.id
    token  = google_secret_manager_secret.fyers_access_token.id
  }
  secret_id = each.value
  role      = "roles/secretmanager.secretAccessor"
  member    = google_service_account.pipeline_runtime.member
}

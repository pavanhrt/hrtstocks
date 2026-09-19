resource "google_artifact_registry_repository" "images" {
  repository_id = local.name_prefix
  location      = var.gcp_region
  format        = "DOCKER"
  description   = "Container images for the web app and the pipeline jobs"

  # Bound storage cost: keep recent images only.
  cleanup_policies {
    id     = "keep-recent"
    action = "KEEP"
    most_recent_versions {
      keep_count = 10
    }
  }
  cleanup_policies {
    id     = "delete-old"
    action = "DELETE"
    condition {
      older_than = "2592000s" # 30 days
    }
  }

  depends_on = [google_project_service.apis]
}

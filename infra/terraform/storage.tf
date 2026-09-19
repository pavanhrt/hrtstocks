# Private bucket for chart SVGs. Never public: the web app streams objects to signed-in users
# through an authenticated route (app/src/app/api/charts), and only registered paths are served.
resource "google_storage_bucket" "charts" {
  name                        = local.charts_bucket
  location                    = var.gcp_region
  storage_class               = "STANDARD"
  uniform_bucket_level_access = true
  public_access_prevention    = "enforced"
  force_destroy               = false

  # Charts are immutable and content-addressed; keep no old versions.
  versioning {
    enabled = false
  }

  # Deleted or overwritten objects are recoverable for 7 days.
  soft_delete_policy {
    retention_duration_seconds = 604800
  }

  # Failed uploads never linger as billable partial objects.
  lifecycle_rule {
    action {
      type = "AbortIncompleteMultipartUpload"
    }
    condition {
      age = 7
    }
  }

  # Optional age-based expiry (off by default: objects are referenced from stored_objects).
  dynamic "lifecycle_rule" {
    for_each = var.charts_max_age_days == null ? [] : [var.charts_max_age_days]
    content {
      action {
        type = "Delete"
      }
      condition {
        age = lifecycle_rule.value
      }
    }
  }

  depends_on = [google_project_service.apis]
}

# Pipeline writes new objects only (immutable: it can never overwrite or delete).
resource "google_storage_bucket_iam_member" "pipeline_creates_charts" {
  bucket = google_storage_bucket.charts.name
  role   = "roles/storage.objectCreator"
  member = google_service_account.pipeline_runtime.member
}

# Web app reads only.
resource "google_storage_bucket_iam_member" "app_reads_charts" {
  bucket = google_storage_bucket.charts.name
  role   = "roles/storage.objectViewer"
  member = google_service_account.app_runtime.member
}

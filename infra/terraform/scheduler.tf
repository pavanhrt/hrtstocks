# Weekday EOD screening. Cloud Scheduler calls the Cloud Run Admin API to start the screening
# job, authenticated as a dedicated service account that may run ONLY that job.
# Not created unless enable_scheduler = true (the FYERS token is rotated manually each day).
resource "google_cloud_scheduler_job" "eod_screening" {
  count     = var.enable_scheduler ? 1 : 0
  name      = "${local.name_prefix}-eod-screening"
  region    = var.gcp_region
  schedule  = var.eod_schedule
  time_zone = var.eod_schedule_time_zone

  attempt_deadline = "60s"

  retry_config {
    retry_count = 0 # a failed start is visible and re-run deliberately, never silently repeated
  }

  http_target {
    http_method = "POST"
    uri         = "https://run.googleapis.com/v2/projects/${var.gcp_project_id}/locations/${var.gcp_region}/jobs/${local.job_names.screening}:run"
    headers = {
      "Content-Type" = "application/json"
    }
    body = base64encode(jsonencode({
      overrides = {
        containerOverrides = [{
          env = [{ name = "TRIGGER_TYPE", value = "scheduled" }]
        }]
      }
    }))

    oauth_token {
      service_account_email = google_service_account.scheduler.email
    }
  }

  depends_on = [google_project_service.apis, google_cloud_run_v2_job_iam_member.starters["scheduler_screening"]]
}

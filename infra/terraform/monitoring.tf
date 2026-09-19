# Cost and failure visibility. Budget alerts are NOTIFICATIONS ONLY: they do not stop spending.
# To bound spend also keep max instances low (app_max_instances), Cloud SQL small, and the
# scheduler off until wanted.

resource "google_monitoring_notification_channel" "email" {
  for_each     = toset(var.alert_emails)
  display_name = "Alerts: ${each.value}"
  type         = "email"
  labels = {
    email_address = each.value
  }
  depends_on = [google_project_service.apis]
}

locals {
  notification_channel_ids = [for c in google_monitoring_notification_channel.email : c.id]
}

# Billing budget: alerts only, no Pub/Sub topic and no Cloud Function. Notifications go to the billing account's
# default IAM recipients (billing administrators and users) and to any alert_emails channels. A budget does NOT
# stop or cap spending.
resource "google_billing_budget" "monthly" {
  provider        = google.billing
  count           = local.budget_enabled ? 1 : 0
  billing_account = var.gcp_billing_account_id
  display_name    = "${local.name_prefix} monthly budget"

  budget_filter {
    projects = ["projects/${var.gcp_project_number}"]
  }

  amount {
    specified_amount {
      currency_code = var.budget_currency
      units         = tostring(local.budget_amount)
    }
  }

  dynamic "threshold_rules" {
    for_each = [0.5, 0.75, 0.9, 1.0]
    content {
      threshold_percent = threshold_rules.value
    }
  }

  all_updates_rule {
    monitoring_notification_channels = local.notification_channel_ids
    disable_default_iam_recipients   = false
  }

  lifecycle {
    precondition {
      condition     = var.budget_currency == "USD" || var.budget_fx_rate_per_usd != null
      error_message = "budget_fx_rate_per_usd is required when budget_currency is not USD."
    }
  }

  depends_on = [google_project_service.billingbudgets]
}

# A pipeline job execution failed (includes an expired FYERS token).
resource "google_monitoring_alert_policy" "job_failed" {
  display_name = "${local.name_prefix}: job execution failed"
  combiner     = "OR"

  conditions {
    display_name = "Cloud Run job failed"
    condition_threshold {
      filter          = "resource.type = \"cloud_run_job\" AND metric.type = \"run.googleapis.com/job/completed_execution_count\" AND metric.labels.result = \"failed\""
      comparison      = "COMPARISON_GT"
      threshold_value = 0
      duration        = "0s"
      aggregations {
        alignment_period   = "300s"
        per_series_aligner = "ALIGN_SUM"
      }
    }
  }

  notification_channels = local.notification_channel_ids
  alert_strategy {
    auto_close = "86400s"
  }
  depends_on = [google_project_service.apis]
}

# The web app is returning server errors.
resource "google_monitoring_alert_policy" "app_5xx" {
  display_name = "${local.name_prefix}: web app 5xx"
  combiner     = "OR"

  conditions {
    display_name = "5xx responses"
    condition_threshold {
      filter          = "resource.type = \"cloud_run_revision\" AND metric.type = \"run.googleapis.com/request_count\" AND metric.labels.response_code_class = \"5xx\" AND resource.labels.service_name = \"${google_cloud_run_v2_service.app.name}\""
      comparison      = "COMPARISON_GT"
      threshold_value = 5
      duration        = "0s"
      aggregations {
        alignment_period   = "300s"
        per_series_aligner = "ALIGN_SUM"
      }
    }
  }

  notification_channels = local.notification_channel_ids
  alert_strategy {
    auto_close = "3600s"
  }
  depends_on = [google_project_service.apis]
}

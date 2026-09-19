# Cloud Run: one web service (scale to zero) and Cloud Run Jobs for batch work. Jobs run
# only while executing and can take hours, unlike the request-scoped web service.
# CI replaces the images on every deploy; Terraform ignores those later changes.

locals {
  db_env = {
    CLOUD_SQL_INSTANCE = local.cloud_sql_conn
    DB_NAME            = local.db_name
  }

  job_names = {
    screening = "${local.name_prefix}-screening"
    buy_setup = "${local.name_prefix}-buy-setup"
    fome      = "${local.name_prefix}-fome"
  }

  # Entrypoint script and limits per pipeline job (same image, different command).
  pipeline_jobs = {
    screening = { script = "src/jobs/screening.mjs", timeout = "7200s", retries = 1 }
    buy_setup = { script = "src/jobs/buy-setup.mjs", timeout = "7200s", retries = 1 }
    fome      = { script = "src/jobs/fome.mjs", timeout = "1800s", retries = 0 } # interactive: fail fast, the user can retry
  }
}

# ------------------------------- web app --------------------------------------
resource "google_cloud_run_v2_service" "app" {
  name     = "${local.name_prefix}-app"
  location = var.gcp_region
  ingress  = "INGRESS_TRAFFIC_ALL" # public HTTPS; every page and API is authenticated in the app (invite-only sign-in)

  template {
    service_account = google_service_account.app_runtime.email

    scaling {
      min_instance_count = 0 # scale to zero
      max_instance_count = var.app_max_instances
    }

    max_instance_request_concurrency = 40

    containers {
      image = var.app_image

      ports {
        container_port = 8080
      }

      resources {
        limits = {
          cpu    = "1"
          memory = "512Mi"
        }
        cpu_idle          = true # CPU only while handling requests
        startup_cpu_boost = true
      }

      startup_probe {
        http_get {
          path = "/api/health"
        }
        initial_delay_seconds = 2
        period_seconds        = 3
        failure_threshold     = 10
      }

      dynamic "env" {
        for_each = merge(local.db_env, {
          DB_USER                         = local.app_db_user
          DB_POOL_MAX                     = "4"
          CHART_BUCKET                    = google_storage_bucket.charts.name
          GCP_PROJECT                     = var.gcp_project_id
          GCP_REGION                      = var.gcp_region
          SCREENING_JOB_NAME              = local.job_names.screening
          BUY_SETUP_JOB_NAME              = local.job_names.buy_setup
          FOME_JOB_NAME                   = local.job_names.fome
          SIGNUP_MODE                     = var.signup_mode
          NEXT_PUBLIC_FIREBASE_PROJECT_ID = var.gcp_project_id
          APP_BASE_URL                    = local.app_base_url
          ALLOWED_ORIGINS                 = join(",", local.allowed_origins)
        })
        content {
          name  = env.key
          value = env.value
        }
      }
    }
  }

  lifecycle {
    ignore_changes = [
      template[0].containers[0].image,
      client,
      client_version,
    ]
  }

  depends_on = [google_project_service.apis]
}

# The service is publicly reachable; the app itself enforces sign-in.
resource "google_cloud_run_v2_service_iam_member" "public" {
  name     = google_cloud_run_v2_service.app.name
  location = var.gcp_region
  role     = "roles/run.invoker"
  member   = "allUsers"
}

# The custom domain is served by Firebase Hosting, which rewrites to this service (firebase.tf). The raw
# run.app URL stays reachable (Hosting cannot reach an internal-only service) but is not an allowed
# origin for state-changing requests, is not an authorized sign-in domain, and is never documented as the
# entry point; it serves the same authenticated application.

# ------------------------------- pipeline jobs ------------------------------------
# Three Cloud Run Jobs from one image. They run only while executing (billed per second) and can take
# hours, unlike the request-scoped web service.
resource "google_cloud_run_v2_job" "pipeline" {
  for_each = local.pipeline_jobs
  name     = local.job_names[each.key]
  location = var.gcp_region

  template {
    task_count = 1
    template {
      service_account = google_service_account.pipeline_runtime.email
      max_retries     = each.value.retries
      timeout         = each.value.timeout

      containers {
        image   = var.pipeline_image
        command = ["node"]
        args    = [each.value.script]

        resources {
          limits = {
            cpu    = "1"
            memory = "1Gi"
          }
        }

        dynamic "env" {
          for_each = merge(local.db_env, { DB_USER = local.pipeline_db_user, CHART_BUCKET = google_storage_bucket.charts.name })
          content {
            name  = env.key
            value = env.value
          }
        }
        env {
          name = "FYERS_APP_ID"
          value_source {
            secret_key_ref {
              secret  = google_secret_manager_secret.fyers_app_id.secret_id
              version = "latest"
            }
          }
        }
        env {
          name = "FYERS_ACCESS_TOKEN"
          value_source {
            secret_key_ref {
              secret  = google_secret_manager_secret.fyers_access_token.secret_id
              version = "latest"
            }
          }
        }
      }
    }
  }

  lifecycle {
    ignore_changes = [template[0].template[0].containers[0].image, client, client_version]
  }

  depends_on = [google_project_service.apis, google_secret_manager_secret_iam_member.pipeline_reads_fyers]
}

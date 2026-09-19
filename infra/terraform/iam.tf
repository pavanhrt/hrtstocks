# Separate runtime identities per workload, each with only the roles it needs.
# No service-account keys are ever created: workloads use their attached identity,
# CI uses Workload Identity Federation (wif.tf).
#
# There is NO migration identity and NO custom role: schema changes are applied by the operator from a
# workstation (Cloud SQL Auth Proxy, built-in `postgres` user), and every role below is a predefined role
# bound to the narrowest resource that supports it. No IAM is granted to the operator: the operator is
# expected to hold the administrative access needed to run Terraform (see docs/gcp/iam-proposal.md).

resource "google_service_account" "app_runtime" {
  account_id   = "${local.name_prefix}-app"
  display_name = "Web app runtime (${var.environment})"
  depends_on   = [google_project_service.apis]
}

resource "google_service_account" "pipeline_runtime" {
  account_id   = "${local.name_prefix}-pipe"
  display_name = "Pipeline jobs runtime (${var.environment})"
  depends_on   = [google_project_service.apis]
}

resource "google_service_account" "scheduler" {
  account_id   = "${local.name_prefix}-sched"
  display_name = "Cloud Scheduler invoker (${var.environment})"
  depends_on   = [google_project_service.apis]
}

resource "google_service_account" "deployer" {
  account_id   = "${local.name_prefix}-deploy"
  display_name = "CI/CD deployer, impersonated through Workload Identity Federation (${var.environment})"
  depends_on   = [google_project_service.apis]
}

# ---- Cloud SQL access (IAM database authentication) ----------------------------
# Restricted with an IAM condition to this environment's one instance. The web and pipeline identities
# may connect and log in; neither may administer the instance.
locals {
  sql_runtime_members = {
    app      = google_service_account.app_runtime.member
    pipeline = google_service_account.pipeline_runtime.member
  }
  sql_instance_condition = {
    title       = "only-${local.name_prefix}-pg"
    description = "Limits Cloud SQL access to this environment's instance"
    expression  = "resource.type == \"sqladmin.googleapis.com/Instance\" && resource.name == \"projects/${var.gcp_project_id}/instances/${local.name_prefix}-pg\""
  }
}

resource "google_project_iam_member" "sql_client" {
  for_each = local.sql_runtime_members
  project  = var.gcp_project_id
  role     = "roles/cloudsql.client"
  member   = each.value

  condition {
    title       = local.sql_instance_condition.title
    description = local.sql_instance_condition.description
    expression  = local.sql_instance_condition.expression
  }
}

resource "google_project_iam_member" "sql_instance_user" {
  for_each = local.sql_runtime_members
  project  = var.gcp_project_id
  role     = "roles/cloudsql.instanceUser"
  member   = each.value

  condition {
    title       = local.sql_instance_condition.title
    description = local.sql_instance_condition.description
    expression  = local.sql_instance_condition.expression
  }
}

# ---- Web app and scheduler may start pipeline jobs (only those jobs, only run-with-overrides) ----
# roles/run.jobsExecutorWithOverrides = run.jobs.run, run.jobs.runWithOverrides, run.executions.cancel.
locals {
  job_starters = {
    app_screening       = { job = "screening", member = google_service_account.app_runtime.member }
    app_buy_setup       = { job = "buy_setup", member = google_service_account.app_runtime.member }
    app_fome            = { job = "fome", member = google_service_account.app_runtime.member }
    scheduler_screening = { job = "screening", member = google_service_account.scheduler.member }
  }
}

resource "google_cloud_run_v2_job_iam_member" "starters" {
  for_each = local.job_starters
  name     = google_cloud_run_v2_job.pipeline[each.value.job].name
  location = var.gcp_region
  role     = "roles/run.jobsExecutorWithOverrides"
  member   = each.value.member
}

# ---- Deployer: push images, update the service and the jobs, nothing else --------------
resource "google_artifact_registry_repository_iam_member" "deployer_writes_images" {
  repository = google_artifact_registry_repository.images.name
  location   = var.gcp_region
  role       = "roles/artifactregistry.writer"
  member     = google_service_account.deployer.member
}

# roles/run.developer bound to the individual service and jobs, not the project.
resource "google_cloud_run_v2_service_iam_member" "deployer_updates_app" {
  name     = google_cloud_run_v2_service.app.name
  location = var.gcp_region
  role     = "roles/run.developer"
  member   = google_service_account.deployer.member
}

resource "google_cloud_run_v2_job_iam_member" "deployer_updates_jobs" {
  for_each = google_cloud_run_v2_job.pipeline
  name     = each.value.name
  location = var.gcp_region
  role     = "roles/run.developer"
  member   = google_service_account.deployer.member
}

# Deploying a revision that runs as a service account requires act-as on that account only.
resource "google_service_account_iam_member" "deployer_acts_as" {
  for_each = {
    app      = google_service_account.app_runtime.name
    pipeline = google_service_account.pipeline_runtime.name
  }
  service_account_id = each.value
  role               = "roles/iam.serviceAccountUser"
  member             = google_service_account.deployer.member
}

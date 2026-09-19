# PAID RESOURCE. Not created unless enable_cloud_sql = true. Cloud SQL has no permanent free
# tier (only the new-account trial credit), so this is the main recurring cost.
#
# Initial QA / MVP: db-f1-micro, single zone, no HA, minimum storage.
# That tier is shared-core and carries NO SLA: it is non-production. For public production choose
# the smallest SLA-eligible tier after load testing and set cloud_sql_tier (see docs/gcp/cost-and-sizing.md).
#
# Network exposure: the instance has a public IPv4 address but ZERO authorized networks, TLS is
# required, and the only way in is the Cloud SQL connector (IAM-authorized, mutual-TLS). It is not
# reachable by IP allow-listing. A private-IP + VPC design is the next hardening step if wanted.

resource "google_sql_database_instance" "main" {
  count               = var.enable_cloud_sql ? 1 : 0
  name                = "${local.name_prefix}-pg"
  region              = var.gcp_region
  database_version    = var.cloud_sql_postgres_version
  deletion_protection = var.cloud_sql_deletion_protection

  settings {
    edition           = var.cloud_sql_edition
    tier              = var.cloud_sql_tier
    availability_type = var.cloud_sql_availability_type
    disk_type         = "PD_SSD"
    disk_size         = var.cloud_sql_disk_size_gb
    disk_autoresize   = true

    ip_configuration {
      ipv4_enabled = true
      ssl_mode     = "ENCRYPTED_ONLY"
      # No authorized_networks blocks: nothing is allow-listed by IP.
    }

    database_flags {
      name  = "cloudsql.iam_authentication"
      value = "on"
    }

    backup_configuration {
      enabled                        = true
      start_time                     = "21:00" # UTC; ~02:30 IST, outside market hours
      point_in_time_recovery_enabled = false   # enable for production (extra storage cost)
      backup_retention_settings {
        retained_backups = 7
      }
    }

    maintenance_window {
      day  = 7 # Sunday
      hour = 20
    }

    insights_config {
      query_insights_enabled = true
    }
  }

  depends_on = [google_project_service.apis]
}

resource "google_sql_database" "app" {
  count    = var.enable_cloud_sql ? 1 : 0
  name     = local.db_name
  instance = google_sql_database_instance.main[0].name
}

# Runtime identities authenticate with IAM (no passwords). Their table access comes from the
# app_web / app_pipeline group roles, granted by the operator when applying migrations (GRANT_ROLES,
# docs/gcp/runbooks/qa-deployment.md). Schema changes are made by the operator with the built-in
# `postgres` user, whose password is set out of band and is therefore never in Terraform state.
resource "google_sql_user" "app_iam" {
  count    = var.enable_cloud_sql ? 1 : 0
  name     = local.app_db_user
  instance = google_sql_database_instance.main[0].name
  type     = "CLOUD_IAM_SERVICE_ACCOUNT"
}

resource "google_sql_user" "pipeline_iam" {
  count    = var.enable_cloud_sql ? 1 : 0
  name     = local.pipeline_db_user
  instance = google_sql_database_instance.main[0].name
  type     = "CLOUD_IAM_SERVICE_ACCOUNT"
}

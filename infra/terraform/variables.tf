# ---------------------------------------------------------------------------
# Google Cloud account / project identity (all configurable; nothing is hard-coded).
# ---------------------------------------------------------------------------
variable "gcp_operator_email" {
  description = "Google Cloud account used by the developer for local administrative operations"
  type        = string
}

variable "gcp_project_id" {
  description = "Google Cloud project ID"
  type        = string
}

variable "gcp_project_number" {
  description = "Google Cloud project number"
  type        = string
}

variable "gcp_organization_name" {
  description = "Google Cloud organization display name"
  type        = string
}

variable "gcp_organization_id" {
  description = "Numeric Google Cloud organization ID"
  type        = string
  default     = null
  nullable    = true
}

variable "gcp_billing_account_id" {
  description = "Google Cloud billing account ID"
  type        = string
  default     = null
  nullable    = true
}

variable "gcp_region" {
  description = "Primary Google Cloud region"
  type        = string
  default     = "asia-south1"
}

variable "custom_domain" {
  description = "Custom application domain served by Firebase Hosting (managed TLS), for example qa.example.com. Null serves only the Firebase-generated URL."
  type        = string
  default     = null
  nullable    = true
  validation {
    condition     = var.custom_domain == null ? true : can(regex("^([a-z0-9]([a-z0-9-]*[a-z0-9])?\\.)+[a-z]{2,}$", var.custom_domain))
    error_message = "custom_domain must be a plain lowercase host name (no scheme, path, port or wildcard)."
  }
}

variable "firebase_site_id" {
  description = "Firebase Hosting site ID (globally unique, 4-30 lowercase letters, digits or hyphens). Null derives <project-id>-<environment>."
  type        = string
  default     = null
  nullable    = true
  validation {
    condition     = var.firebase_site_id == null ? true : can(regex("^[a-z0-9][a-z0-9-]{2,28}[a-z0-9]$", var.firebase_site_id))
    error_message = "firebase_site_id must be 4-30 lowercase letters, digits or hyphens, not starting or ending with a hyphen."
  }
}

variable "extra_allowed_origins" {
  description = "Additional EXACT origins (https://host, no wildcard, no path) allowed to send state-changing requests. The custom domain and the Firebase-generated URL are always allowed; the raw Cloud Run URL never is."
  type        = list(string)
  default     = []
  validation {
    condition     = alltrue([for o in var.extra_allowed_origins : can(regex("^https://[a-z0-9]([a-z0-9.-]*[a-z0-9])?(:[0-9]{1,5})?$", o))])
    error_message = "extra_allowed_origins entries must look like https://host (lowercase, no wildcard, no path)."
  }
}

# ---------------------------------------------------------------------------
# Environment shape
# ---------------------------------------------------------------------------
variable "environment" {
  description = "Short environment name used in resource names (for example qa or prod)."
  type        = string
  default     = "qa"
  validation {
    condition     = can(regex("^[a-z][a-z0-9-]{1,14}$", var.environment))
    error_message = "environment must be 2-15 lowercase letters, digits or hyphens, starting with a letter."
  }
}

# --- Cloud SQL (PAID: not free after the new-account trial credit) ---------
variable "enable_cloud_sql" {
  description = "Create the Cloud SQL instance (the main recurring cost; see docs/gcp/cost-and-sizing.md)."
  type        = bool
  default     = true
}

variable "cloud_sql_tier" {
  description = "Cloud SQL machine tier. db-f1-micro is shared-core and non-SLA: fine for a private MVP, NOT for public production. For production pick the smallest SLA-eligible tier after load testing (docs/gcp/cost-and-sizing.md)."
  type        = string
  default     = "db-f1-micro"
}

variable "cloud_sql_edition" {
  description = "Cloud SQL edition. db-f1-micro and db-g1-small require ENTERPRISE."
  type        = string
  default     = "ENTERPRISE"
}

variable "cloud_sql_availability_type" {
  description = "ZONAL (no HA, default) or REGIONAL (high availability). HA can be enabled later by changing this value: see docs/gcp/cost-and-sizing.md."
  type        = string
  default     = "ZONAL"
  validation {
    condition     = contains(["ZONAL", "REGIONAL"], var.cloud_sql_availability_type)
    error_message = "cloud_sql_availability_type must be ZONAL or REGIONAL."
  }
}

variable "cloud_sql_disk_size_gb" {
  description = "Initial SSD size in GB (10 is the minimum). Storage auto-increase stays on."
  type        = number
  default     = 10
}

variable "cloud_sql_postgres_version" {
  description = "PostgreSQL major version."
  type        = string
  default     = "POSTGRES_17"
}

variable "cloud_sql_deletion_protection" {
  description = "Protect the instance from accidental deletion."
  type        = bool
  default     = true
}

# --- Container images (CI deploys real images; Terraform ignores later changes) ---
variable "app_image" {
  description = "Initial web app image. CI replaces it on every deploy."
  type        = string
  default     = "us-docker.pkg.dev/cloudrun/container/hello"
}

variable "pipeline_image" {
  description = "Initial pipeline job image. CI replaces it on every deploy."
  type        = string
  default     = "us-docker.pkg.dev/cloudrun/container/job"
}

variable "app_max_instances" {
  description = "Upper bound on web instances (cost guard). The app scales to zero."
  type        = number
  default     = 1
}

# --- Auth ---------------------------------------------------------------
variable "signup_mode" {
  description = "invite_only (default) or open. Do not enable open signup until email verification, abuse controls, authorization tests and cost controls are ready."
  type        = string
  default     = "invite_only"
  validation {
    condition     = contains(["invite_only", "open"], var.signup_mode)
    error_message = "signup_mode must be invite_only or open."
  }
}

# --- Bootstrap administrator --------------------------------------------------
variable "bootstrap_admin_email" {
  description = "E-mail of the first system administrator. Null (default) means NO administrator is provisioned and no user is created or invited. Terraform never creates a user: when set, it only records that the operator intends to seed this address (BOOTSTRAP_ADMIN_EMAIL for the seed command, docs/gcp/authentication.md). Never assumed to be the operator e-mail."
  type        = string
  default     = null
  nullable    = true
  validation {
    condition     = var.bootstrap_admin_email == null ? true : can(regex("^[^@\\s]+@[^@\\s]+\\.[^@\\s]+$", var.bootstrap_admin_email))
    error_message = "bootstrap_admin_email must be a valid e-mail address or null."
  }
}

# --- Scheduling ------------------------------------------------------------
variable "enable_scheduler" {
  description = "Create the weekday EOD Cloud Scheduler job. The FYERS token is refreshed manually each day, so a scheduled run fails clearly if the token was not rotated; keep this false until unattended runs are wanted."
  type        = bool
  default     = false
}

variable "eod_schedule" {
  description = "Cron schedule for the EOD screening run (in eod_schedule_time_zone). Default: weekdays 15:45 IST, after the NSE close."
  type        = string
  default     = "45 15 * * 1-5"
}

variable "eod_schedule_time_zone" {
  description = "Time zone for eod_schedule."
  type        = string
  default     = "Asia/Kolkata"
}

# --- CI/CD ------------------------------------------------------------------
variable "github_repository" {
  description = "GitHub repository allowed to deploy via Workload Identity Federation, as owner/name. Null disables the pool."
  type        = string
  default     = null
  nullable    = true
}

variable "screening_job_max_retries" {
  description = "Cloud Run retries of a FAILED screening task (0 = none). The shipped default is 1; QA sets 0 so a failing real run stops immediately instead of repeating against the data provider."
  type        = number
  default     = 1
  validation {
    condition     = var.screening_job_max_retries >= 0 && var.screening_job_max_retries <= 3
    error_message = "screening_job_max_retries must be between 0 and 3."
  }
}

variable "github_environment" {
  description = "GitHub Actions environment whose jobs may deploy (WIF attribute condition). Null uses the environment variable."
  type        = string
  default     = null
  nullable    = true
}

variable "github_deploy_branches" {
  description = "Git refs allowed to deploy (WIF attribute condition)."
  type        = list(string)
  default     = ["refs/heads/develop_gcloud"]
}

# --- Cost control / alerting --------------------------------------------------
variable "monthly_budget_amount_usd" {
  description = "Monthly budget in USD for the billing budget (alerts at 50/75/90/100 %). Null creates no budget. Budgets NOTIFY only: they do not stop spending."
  type        = number
  default     = null
  nullable    = true
  validation {
    condition     = var.monthly_budget_amount_usd == null ? true : var.monthly_budget_amount_usd > 0
    error_message = "monthly_budget_amount_usd must be positive."
  }
}

variable "budget_currency" {
  description = "Currency of the billing account. Google requires the budget to use it; when it is not USD, budget_fx_rate_per_usd converts monthly_budget_amount_usd."
  type        = string
  default     = "USD"
}

variable "budget_fx_rate_per_usd" {
  description = "Units of budget_currency per 1 USD (for example 96 for INR). Required when budget_currency is not USD; ignored otherwise."
  type        = number
  default     = null
  nullable    = true
  validation {
    condition     = var.budget_fx_rate_per_usd == null ? true : var.budget_fx_rate_per_usd > 0
    error_message = "budget_fx_rate_per_usd must be positive."
  }
}

variable "charts_max_age_days" {
  description = "Delete chart objects older than this many days. Null (default) keeps them: charts are content-addressed and referenced from stored_objects, so age-based deletion must be a deliberate decision."
  type        = number
  default     = null
  nullable    = true
}

variable "alert_emails" {
  description = "E-mail addresses for budget and failure alerts."
  type        = list(string)
  default     = []
}

# IAM design for the no-data-migration QA architecture (NOT APPLIED)

**Status: implemented in Terraform, validated and planned (63 creations, 0 destructions), not applied.** Nothing here exists in Google Cloud until the owner approves the QA deployment.
Compared with the earlier proposal, the architecture no longer has a migration identity, a migration job, a migrator database user or a job-runner custom role.

**The operator account receives nothing automatically.** `gcp_operator_email` is declared in `variables.tf` and is not referenced by any resource; no `user:` or `group:` member appears anywhere in the configuration.

## Identities (four service accounts)

| Service account | Purpose |
|---|---|
| `…-app` | web app runtime |
| `…-pipe` | pipeline jobs runtime (screening, buy-setup, fome) |
| `…-sched` | Cloud Scheduler invoker (only used when `enable_scheduler = true`) |
| `…-deploy` | CI/CD deployer, impersonated through Workload Identity Federation |

Removed: `…-mig`, the migration-runner custom role, `serviceAccountUser` on a migration identity, the `migrator` database user and its generated password/secret, the `migrate` and `seed` jobs, and `roles/errorreporting.writer`
(Error Reporting ingests Cloud Run stdout/stderr automatically; no code calls its API).

## Bindings (all predefined roles, no custom role)

| Member | Role | Scope | Used for |
|---|---|---|---|
| app, pipe | `roles/cloudsql.client` | project, **IAM condition: this environment's one instance** | connect (`cloudsql.instances.connect/get`) |
| app, pipe | `roles/cloudsql.instanceUser` | project, same condition | IAM database login |
| app | `roles/storage.objectViewer` | the chart bucket | read/stream charts |
| pipe | `roles/storage.objectCreator` | the chart bucket | create new charts (cannot overwrite or delete) |
| pipe | `roles/secretmanager.secretAccessor` | the two FYERS secrets | read the FYERS credentials at job start |
| app | `roles/run.jobsExecutorWithOverrides` | each of the 3 jobs | start an execution with per-run arguments |
| scheduler | `roles/run.jobsExecutorWithOverrides` | the screening job only | scheduled start |
| deploy | `roles/artifactregistry.writer` | the repository | push images |
| deploy | `roles/run.developer` | the web service and each of the 3 jobs (**not project-wide**) | update image/revision |
| deploy | `roles/iam.serviceAccountUser` | the app and pipe service accounts only | deploy revisions that run as them |
| GitHub principalSet | `roles/iam.workloadIdentityUser` | the deploy service account | keyless CI auth; provider condition: this repository **and** the `qa` environment claim **and** the approved branch |
| `allUsers` | `roles/run.invoker` | the web service | public HTTPS (sign-in is enforced in the app) |

**Validation of permissions.** `roles/run.jobsExecutorWithOverrides` was read from Google's role catalog (read-only `gcloud iam roles describe`): it contains `run.jobs.run`, `run.jobs.runWithOverrides`
and `run.executions.cancel`. The app calls `JobsClient.runJob` with overrides and never polls, so no `run.jobs.get` / `run.executions.get` is required. Because no custom role exists, there are no custom-role permissions to validate.

## Decisions and residual risks

- **No migration identity.** Schema changes are made by the operator from a workstation through the Cloud SQL Auth Proxy with the built-in `postgres` user (password set out of band, never in Terraform state).
  This removes the path "push to a branch → run code as the database owner". The deployer has no database access at all.
- **Deployer scope is UNVERIFIED end to end.** Resource-level `run.developer` matches Google's model for updating an existing service/job, but this has not been exercised (nothing is deployed). If the first CI deploy is refused for a missing permission,
  the failure will name it; widening to project-level `roles/run.developer` would be a **new approval**, not applied silently.
- **Deploying code is deploying identity.** Whoever can push to `develop_gcloud` *and* approve the `qa` environment can run arbitrary code as the app and pipeline identities. Mitigate with required reviewers and branch protection.
- **Public entry.** Hosting cannot reach an internal-only Cloud Run service, so the run.app URL remains reachable; the app's own authentication and exact-origin CSRF check still apply there.
- `cloudsql.client` is conditioned on the instance name; IAM Conditions on Cloud SQL resources are supported, but the condition is **UNVERIFIED until applied**.

## Operator account (`gcp_operator_email`): nothing granted automatically

To run `terraform apply` the operator needs, in the project, roughly: `roles/resourcemanager.projectIamAdmin` (to bind the roles above), `roles/serviceusage.serviceUsageAdmin`, `roles/iam.serviceAccountAdmin`,
`roles/iam.workloadIdentityPoolAdmin`, `roles/run.admin`, `roles/cloudsql.admin`, `roles/secretmanager.admin`, `roles/artifactregistry.admin`, `roles/storage.admin`, `roles/cloudscheduler.admin`,
`roles/monitoring.admin`, `roles/firebase.admin`, `roles/firebaseauth.admin`, `roles/serviceusage.apiKeysAdmin`, and `roles/iam.serviceAccountUser` on the service accounts above.
These are broad; grant them only for the apply window (or use the project's existing Owner role) and remove afterwards. Billing and organization roles are **not** needed: this configuration does not link, unlink or change billing, and creates no organization resource. (Only when a budget is configured (`monthly_budget_amount_usd`), creating the budget needs `roles/billing.costsManager` on the billing account.)

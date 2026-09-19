# Terraform: Google Cloud infrastructure

Small, flat configuration. **Nothing here has been applied.** Applying creates cloud resources and
some of them cost money, so it needs an explicit, separate approval.

## What it defines

| File | Resources |
|---|---|
| `project.tf` | Project-number guard (fails the plan if `gcp_project_number` differs from the real project); shared locals (names, hosting URLs, allowed origins) |
| `apis.tf` | Required Google APIs (incl. Firebase and Firebase Hosting) |
| `artifact_registry.tf` | Docker repository with cleanup policy |
| `iam.tf` | Four service accounts (app, pipeline, scheduler, deployer) and least-privilege predefined-role bindings. No migration identity, no custom role |
| `wif.tf` | Workload Identity Federation for GitHub Actions (repository + `qa` environment + branch; no service-account keys) |
| `cloud_sql.tf` | Cloud SQL for PostgreSQL 17, Enterprise `db-f1-micro`, zonal, empty database, IAM DB users for the runtime identities (no password user) |
| `storage.tf` | Empty private chart bucket, public access prevention, lifecycle rules |
| `secrets.tf` | Empty Secret Manager containers (FYERS values are added out of band; Terraform never writes a secret value) |
| `cloud_run.tf` | Web service (min 0 / max 1) and three Cloud Run Jobs: screening, buy-setup, fome |
| `firebase.tf` | Firebase project, Hosting site, custom domain (managed TLS), catch-all rewrite to Cloud Run (google-beta provider) |
| `scheduler.tf` | Weekday EOD trigger (off by default) |
| `identity.tf` | Identity Platform config (invite-only, authorized domains) and a restricted browser API key |
| `monitoring.tf` | Job-failure and 5xx alerts; the billing budget (alerts only) when `monthly_budget_amount_usd` and a billing account id are set |

Organization-level resources are **not** created and billing is **never** linked, unlinked or changed. `gcp_organization_id` is unused while null.
`gcp_billing_account_id` is used only for the optional budget, which stays off until the amount is approved. Outputs contain no account, billing or
credential value.

## Configuration

Copy the example and fill in your values. The real file is git-ignored:

```bash
cp terraform.tfvars.example terraform.tfvars
```

No account, project, region or domain value is hard-coded anywhere in the `.tf` files.

## Authentication (no credentials in the repository)

```bash
gcloud auth login
gcloud auth application-default login
```

Terraform uses Application Default Credentials. The operator account is never set as a provider
credential, and this configuration never grants IAM roles to `gcp_operator_email`
(see `docs/gcp/iam-proposal.md`).

## Validate without touching the cloud

```bash
terraform init -backend=false
terraform validate
terraform fmt -check
```

## Apply (only after approval)

1. Create the private state bucket (see `backend.tf.example`).
2. `terraform plan -out plan.tfplan` and review it, especially anything marked *paid*.
3. `terraform apply plan.tfplan`.
4. DNS records, migrations and seed, FYERS secrets: [`docs/gcp/runbooks/qa-deployment.md`](../../docs/gcp/runbooks/qa-deployment.md).

Cost notes and tier sizing: `docs/gcp/cost-and-sizing.md`.

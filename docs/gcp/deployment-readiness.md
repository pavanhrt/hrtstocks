# Deployment-readiness report: QA (no-data-migration architecture)

Phase 1 (implementation) and Phase 2 (read-only plan) were completed and accepted; QA deployment was then approved (`APPROVE QA DEPLOYMENT`). The sections below record the accepted Phase 1/2 results; the deployment record is in the QA deployment runbook and the final report. No cloud resource was created or changed, billing was not touched, no historical
Supabase project or key was contacted or used, and no secret was displayed. The results below were produced by running the commands.

## Recommendation

**GO for the owner's review, then for the QA deployment once `APPROVE QA DEPLOYMENT` is sent.** The code, schema, seed, pipelines and infrastructure definition are verified locally and the Terraform plan is clean
(68 creations after adding the budget and Workload Identity Federation, 0 changes, 0 destructions). It is **not** a claim that the cloud integrations work: everything in "Unverified until deployment" below is first exercised in Phase 3.

## Phase 1: local verification (all run on `develop_gcloud`)

| Check | Result |
|---|---|
| Root tests (`npm test`) | db **18/18** (migrations, SQL tests, clean-database smoke), pipeline **759/759**, scripts **8/8** |
| App: lint, typecheck, tests, build | lint 0 warnings, typecheck clean, **83/83** tests, production build passes (routes include `/api/health/ready`, `/fyers/callback`; none of `/buy-signals`, `/sell-signals`, `/backtests`) |
| Total | **868 tests, 0 failures** |
| Clean database | 21 migrations apply in order on an empty PostgreSQL 17, second run applies **0**, only extension `pgcrypto`, seed inserts exactly the documented tables and is idempotent ([seed-data.md](seed-data.md)) |
| Built app against the clean database | 25+ black-box checks (`scripts/qa-smoke.mjs`): liveness, readiness (`migrationsApplied = 21`), invite-only login page, security headers, `no-store`, protected pages redirect, protected APIs 401, **forged `system_admin` cookie rejected**, cross-origin and Origin-less POST 403, garbage token 401, removed routes 404, FYERS callback does not echo the code and sends `no-referrer` |
| First run on an empty DB | empty start; NSE outage publishes nothing; **partial FYERS failure publishes nothing** (found and fixed: previously a partial ingestion could publish); re-run publishes exactly one snapshot with no duplicate bars; resuming a finished/failed run is a no-op |
| Storage | SVG validation (type, 2 MB, no script/event/external references), overwrite refused, `&` in NSE symbols (M&M) served |
| Terraform | `fmt -check` clean, `init`, `validate` pass |
| Workflows / Dockerfiles | both workflow files parse and reference no secrets; every `COPY` source exists and is not `.dockerignore`d. `actionlint` and `hadolint` are not installed here (earlier passes ran them; not re-run) |
| Secret scan (index + untracked, type-only) | none found; `terraform.tfvars` is ignored and untracked; `.env.local` not tracked |
| No runtime Supabase/Netlify dependency | 0 in package manifests, lockfiles, imports, Dockerfiles, workflows, Terraform. Remaining mentions are comments and docs that explain the replacement |
| Only `develop_gcloud` changed | `develop` = `origin/develop`, `main` = `origin/main`; original checkout still on `develop` with only your `.env.local` change and `sector-report.json`; **no commit exists** for this work |

Known, unchanged: one legacy SQL test fails identically before and after the port (`bind_fundamental_scores_for_refresh`, "got 1, want 0"); it is allow-listed by exact message in `db/tests/migrations.test.mjs` and printed as a known pre-existing failure.
Moderate `npm audit` findings (transitive `uuid` via `gaxios` / `@google-cloud/storage`, not reachable by this code) and the EOL `eslint@8` are unchanged from the earlier report.

## Phase 2: `terraform plan` (read-only, saved as `qa.tfplan`, git-ignored)

`Plan: 68 to add, 0 to change, 0 to destroy.` (63 in the first Phase 2 plan, plus the budget and its API, and the Workload Identity pool, provider and impersonation binding for `pavanhrt/hrtstocks`) Only `develop_gcloud` files changed. The project currently has none of the Run, SQL, Secret Manager, Artifact Registry, Firebase or Identity Platform APIs enabled and
no service account other than an unrelated `claude-code-sa`, so there is nothing to conflict with and **nothing unrelated is touched or destroyed**. Billing is already enabled on the project (checked read-only; not changed).

### Resources created (68)

| Group | Resources |
|---|---|
| APIs (17) | Run, Cloud SQL Admin, Artifact Registry, Secret Manager, Scheduler, IAM, IAM Credentials, STS, Identity Toolkit, API Keys, Storage, Logging, Monitoring, Firebase, Firebase Hosting, Resource Manager, Service Usage (`disable_on_destroy = false`; already-enabled ones are no-ops) |
| Compute | Cloud Run service `hrtstocks-qa-app` (min 0 / max 1, `asia-south1`); 3 Cloud Run Jobs (`-screening`, `-buy-setup`, `-fome`) |
| Data | Cloud SQL `hrtstocks-qa-pg` (PostgreSQL 17, Enterprise `db-f1-micro`, zonal, 10 GB, 7-day backups, no PITR, deletion protection **on**, TLS required, no authorized networks), database `hrtstocks`, 2 IAM database users; private bucket `hrtstocks-qa-charts` (public access prevention, uniform access, lifecycle rule, 7-day soft delete) |
| Edge | Firebase project, Hosting site `hrtstocks-qa`, custom domain `hrtstocksqa.manaoorugpt.com`, Hosting version (one catch-all rewrite to Cloud Run) and release |
| Identity | Identity Platform config (sign-up **disabled**; authorized domains: the custom domain and the two Firebase hostnames), restricted browser API key |
| Secrets | 2 empty Secret Manager containers (FYERS app id, access token) |
| Registry | Artifact Registry repository `hrtstocks-qa` (keep 10 newest, delete > 30 days) |
| Identities | 4 service accounts: app, pipeline, scheduler, deployer |
| Monitoring | 2 alert policies (job failed, web 5xx); no notification channels (`alert_emails` empty) |
| Misc | project-number guard (`terraform_data`) |

**Not created, by design:** no Cloud Run domain mapping, no load balancer or any `google_compute_*` resource, no Cloud Scheduler job, no Pub/Sub topic or Cloud Function for budget alerts,
no organization resource, no `user:`/`group:` IAM member, no migration/seed job, no migration service account, no custom role, no `errorreporting.writer`, no password or secret value.

### Planned IAM bindings (20, all predefined roles; details in [iam-proposal.md](iam-proposal.md))

| Member | Role | Scope |
|---|---|---|
| app, pipeline | `cloudsql.client`, `cloudsql.instanceUser` | project, conditioned to instance `hrtstocks-qa-pg` (4 bindings) |
| app | `storage.objectViewer` | chart bucket |
| pipeline | `storage.objectCreator` | chart bucket |
| pipeline | `secretmanager.secretAccessor` | the two FYERS secrets |
| app (×3), scheduler (×1) | `run.jobsExecutorWithOverrides` | each job / the screening job only |
| deployer | `artifactregistry.writer` | the repository |
| deployer | `run.developer` | the web service and each of the 3 jobs (not project-wide) |
| deployer | `iam.serviceAccountUser` | app and pipeline service accounts only |
| `allUsers` | `run.invoker` | the web service (public HTTPS; sign-in is enforced in the app) |

### Security-relevant plan values

`ALLOWED_ORIGINS = https://hrtstocksqa.manaoorugpt.com, https://hrtstocks-qa.web.app` (exact, no wildcard, no `run.app`); `APP_BASE_URL = https://hrtstocksqa.manaoorugpt.com`; `SIGNUP_MODE = invite_only`;
`bootstrap_admin_configured = false` (no user is created or invited). Outputs contain no account, billing or credential identifier (the sensitive `firebase_web_config` holds the public browser key).

## Estimated recurring cost (Cloud Billing Catalog prices, `asia-south1`)

About **USD 22 / month** (worst case about 25; about INR 2,100), below the USD 30 limit; Cloud SQL is about 20 of it. Per-service table and assumptions: [cost-and-sizing.md](cost-and-sizing.md).
A **USD 30 budget** (created as INR 2,880: the billing account is billed in INR) alerts at 50 / 75 / 90 / 100 % through billing-account notifications. **It only alerts; it does not stop spending.**

## Values you need to know (exact)

- **FYERS redirect URI** (set by you on the FYERS app; this work does not modify it): `https://hrtstocksqa.manaoorugpt.com/fyers/callback`
- **DNS**: Firebase Hosting returns the exact records after the custom domain is created, so they are printed by `terraform output dns_records_required` after apply, not before. Expect an ownership `TXT` record and either an `A`/`AAAA` pair or a `CNAME` for the single host `hrtstocksqa`.
  Nothing else at `manaoorugpt.com` changes. Until the records are in place, test on `https://hrtstocks-qa.web.app`.
- **Firebase site id** `hrtstocks-qa` is derived; if it is already taken globally, set `firebase_site_id` (the apply would fail with a clear error before anything depends on it).

## Unverified until deployment (not claimed to work)

Docker image builds (no Docker here; CI builds them) · Cloud SQL IAM authentication and the IAM-condition on `cloudsql.client`/`instanceUser` · resource-level `run.developer` being sufficient for `gcloud run deploy` / `jobs update` ·
Firebase Hosting rewrite, `__session` forwarding and managed certificate · Identity Platform sign-in, invite and session-cookie flow with a real account · Secret Manager mounts · a real FYERS/NSE run · Storage upload/download through the real bucket ·
Workload Identity Federation (needs `github_repository`) · the alert policies and the (optional) budget · `terraform apply` itself (permissions of the operator account, Firebase terms acceptance, site-id availability).

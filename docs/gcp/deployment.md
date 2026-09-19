# Deployment

> **Nothing has been deployed.** Creating any cloud resource, applying Terraform or deploying needs the owner's exact approval phrase (`APPROVE QA DEPLOYMENT`).
> The step-by-step QA procedure is [runbooks/qa-deployment.md](runbooks/qa-deployment.md).

## Division of labor

| Who | Does what | How |
|---|---|---|
| The operator | creates/changes **infrastructure**; applies **schema migrations and the system seed**; adds DNS records and FYERS secret values | `terraform apply` and `npm run db:migrate` / `npm run seed:system` from a workstation with Application Default Credentials (Cloud SQL through the Cloud SQL Auth Proxy) |
| CI (GitHub Actions) | deploys **code** only | Workload Identity Federation → deployer service account; no stored key; only from `develop_gcloud`, only in the `qa` environment |

The deployer can push images to the one Artifact Registry repository and update the one web service and the three pipeline jobs (`roles/run.developer` bound to
each of those resources, not project-wide), and act as the two runtime service accounts. It has **no database, secret or bucket access, cannot start the pipeline jobs, and cannot create infrastructure**.
There is no migration identity and no migration job. See [iam-proposal.md](iam-proposal.md).

## Public entry point

`custom domain → Firebase Hosting (managed TLS) → rewrite ** → Cloud Run (asia-south1)`. Hosting forwards only the `__session` cookie, which is why the session cookie has that name; every dynamic response carries `Cache-Control: private, no-store`,
so Hosting's CDN never caches user data. State-changing requests must come from an **exact allowed origin** (`APP_BASE_URL` + `ALLOWED_ORIGINS`: the custom domain and the Firebase-generated URL; never a wildcard, never the raw Cloud Run URL).
The raw `run.app` URL still answers (Hosting cannot reach an internal-only service) but it is not an allowed origin or sign-in domain and is not published anywhere.

## Reproducible sequence (summary)

1. `terraform plan` / `apply` (empty Cloud SQL, private bucket, service accounts, Cloud Run, jobs, Hosting, Identity Platform, secret containers).
2. DNS records for the one host (printed by `terraform output dns_records_required`).
3. Operator: `db:migrate` (0001–0021, grants runtime roles) → `seed:system`.
4. FYERS secret values added out of band.
5. *Deploy* workflow (images → jobs → web service).
6. Smoke test and the QA checklist.

## Container images

| Image | Dockerfile | Notes |
|---|---|---|
| `app` | `app/Dockerfile` (context `app/`) | Next.js standalone, non-root, port 8080. Only *public* Firebase identifiers are baked in |
| `pipeline` | `services/pipeline/Dockerfile` (context repo root) | One image for `screening`, `buy-setup`, `fome`, chosen by container command. Contains no migrations, seed data or specs |

Both images have **not been built** in this environment (no Docker available); CI builds them (`images` job) and that is the first real proof.

## Reproducibility

Images are tagged with the commit SHA. Provider versions are pinned by `infra/terraform/.terraform.lock.hcl`. CI runs lint, types, all tests (including the clean-database smoke), both image builds,
`terraform fmt/validate` and a secret scan on every change.

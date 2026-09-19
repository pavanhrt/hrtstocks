# Environment variables

Nothing environment-specific is hard-coded. Secrets are never committed: local values live in ignored files
(`app/.env.local`, `services/pipeline/.env.local`), deployed values come from Cloud Run environment and Secret Manager.
Templates: `app/.env.example`, `services/pipeline/.env.example`. Validation: `app/src/lib/config.ts` (zod).

## Old → new (historical names, for readers of older code or notes)

| Old (Supabase/Netlify) | New |
|---|---|
| `NEXT_PUBLIC_SUPABASE_URL`, `NEXT_PUBLIC_SUPABASE_ANON_KEY` | `NEXT_PUBLIC_FIREBASE_PROJECT_ID`, `_API_KEY`, `_AUTH_DOMAIN` (public identifiers) |
| `SUPABASE_SERVICE_ROLE_KEY`, `SUPABASE_SECRET_KEY`, `APP_SECRET_KEYS` | **removed**: workloads use their runtime service account (Application Default Credentials) |
| `SUPABASE_URL` | `CLOUD_SQL_INSTANCE`, `DB_NAME`, `DB_USER` (or `DATABASE_URL` locally) |
| `RUN_SCREENING_FUNCTION_URL`, `ANALYZE_BUY_SETUP_FUNCTION_URL`, `FOME_ANALYSIS_FUNCTION_URL` | `GCP_PROJECT`, `GCP_REGION`, `SCREENING_JOB_NAME`, `BUY_SETUP_JOB_NAME`, `FOME_JOB_NAME` |
| `NEXT_PUBLIC_SITE_URL` | `APP_BASE_URL` (canonical origin, server-side) |
| `FYERS_ACCESS_TOKEN`, `FYERS_APP_ID` (was hard-coded) | same names, **Secret Manager** (`FYERS_APP_ID` no longer hard-coded) |
| `FYERS_SECRET_KEY`, `FYERS_REDIRECT_URI`, `UPSTOX_ACCESS_TOKEN` | operator scripts only, environment, never stored |

## Web app (Cloud Run service)

| Variable | Secret? | Purpose |
|---|---|---|
| `CLOUD_SQL_INSTANCE`, `DB_NAME`, `DB_USER` | no | Cloud SQL connector with IAM database auth (no password) |
| `DATABASE_URL` | local only | plain connection string for development/tests |
| `DB_POOL_MAX` | no | pool size (default 4: Cloud SQL connection budget is small) |
| `CHART_BUCKET` | no | private chart bucket |
| `GCP_PROJECT`, `GCP_REGION`, `SCREENING_JOB_NAME`, `BUY_SETUP_JOB_NAME`, `FOME_JOB_NAME` | no | which jobs the UI may start |
| `JOB_RUNNER` | no | `cloud_run` (default) or `local` (development spawns the job as a child process) |
| `APP_BASE_URL` | no | canonical origin, e.g. `https://hrtstocksqa.manaoorugpt.com`. State-changing requests must come from it or an entry of `ALLOWED_ORIGINS`; in production, with neither set, they are all refused |
| `ALLOWED_ORIGINS` | no | comma-separated **exact** origins (`https://host`, no wildcard, no path). Terraform sets the custom domain and the Firebase-generated URL; never the raw Cloud Run URL |
| `SIGNUP_MODE` | no | `invite_only` (default) or `open` |
| `SESSION_COOKIE_NAME`, `SESSION_MAX_AGE_DAYS` | no | session cookie (defaults `__session`, 5, max 14) |
| `NEXT_PUBLIC_FIREBASE_PROJECT_ID` | no | also used server-side to verify tokens |
| `NEXT_PUBLIC_FIREBASE_API_KEY`, `_AUTH_DOMAIN`, `_SIGNUP_MODE` | no (public) | baked in at **build** time (Docker build args) |
| `FIREBASE_AUTH_EMULATOR_HOST`, `NEXT_PUBLIC_FIREBASE_AUTH_EMULATOR_URL`, `STORAGE_EMULATOR_HOST` | local only | emulators; never set in Cloud Run |

## Pipeline jobs (Cloud Run Jobs)

| Variable | Secret? | Purpose |
|---|---|---|
| `CLOUD_SQL_INSTANCE`, `DB_NAME`, `DB_USER` | no | database (IAM auth) |
| `CHART_BUCKET` | no | chart object store |
| `FYERS_APP_ID`, `FYERS_ACCESS_TOKEN` | **yes** | Secret Manager. The token expires daily: [runbook](runbooks/fyers-token.md) |
| `TRIGGER_TYPE`, `TRIGGERED_BY`, `RESUME_RUN_ID` (screening), `RUN_ID` (buy-setup), `FOME_RUN_ID` (fome) | no | per-execution arguments (validated; UUIDs only) |
| `SCREENING_MAX_RUN_MINUTES`, `BUY_SETUP_MAX_RUN_MINUTES`, `SCREENING_POLL_MS`, `BUY_SETUP_POLL_MS` | no | tuning |

## Operator commands (run from a workstation, never in the cloud)

| Variable | Secret? | Purpose |
|---|---|---|
| `DATABASE_URL` | **yes** (contains the `postgres` password) | connection through the Cloud SQL Auth Proxy for `npm run db:migrate` / `db:status` / `seed:system` |
| `GRANT_ROLES` | no | `terraform output -raw grant_roles`: grants `app_web` / `app_pipeline` to the runtime identities |
| `BOOTSTRAP_ADMIN_EMAIL` | no | only when an administrator address has been supplied; authorizes it, creates no account |
| `SPEC_ROOT` | no | where the seeder finds `strategies/`, `config/`, `fundamentals/` (defaults to the checkout) |

No Supabase project reference, password or key is read by any script or needed to build, test or deploy.

## Secret variable names and where they are referenced

`FYERS_ACCESS_TOKEN`, `FYERS_APP_ID` → `services/pipeline/src/run-screening/providers/fyers-credentials.js` (Secret Manager in the cloud) ·
`DATABASE_URL` → `db/migrate.mjs`, `services/pipeline/src/seed/seed-system.mjs` (operator workstation only).

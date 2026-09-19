# Stock Research Workspace

Evidence-based NSE index/stock research: SMM, PAPA, GUE, and FOME rules converted into an auditable, versioned screening
pipeline. See [docs/project-overview.md](docs/project-overview.md) for the product goals and [AGENTS.md](AGENTS.md) for the
governing rules. This file covers what is here and how to run it.

The application runs on **Google Cloud** (Cloud Run, Cloud SQL for PostgreSQL, Cloud Storage, Identity Platform, Secret Manager,
Cloud Scheduler). Full architecture, runbooks and decisions: **[docs/gcp/](docs/gcp/README.md)**.

> Status: implemented and verified locally (unit, integration, clean-database smoke and end-to-end tests against a real PostgreSQL);
> **nothing has been deployed**. The QA deployment starts from an **empty database** (migrations + a documented system seed): no data from any earlier
> system is migrated, and it is filled by fresh NSE/FYERS pipeline runs. See [docs/gcp/runbooks/qa-deployment.md](docs/gcp/runbooks/qa-deployment.md).

## What's here

```
app/                 Next.js 15 web app (Cloud Run service)              -> app/Dockerfile
services/pipeline/   Cloud Run Jobs: EOD screening, buy-setup, FOME       -> services/pipeline/Dockerfile
db/                  Versioned SQL migrations (0001-0021, the schema's source of truth), runner, SQL tests
infra/terraform/     Infrastructure as code (validated and planned, not applied)
hosting/             Firebase Hosting config template (Terraform is authoritative)
.github/workflows/   CI and deploy (Workload Identity Federation; no stored cloud credentials)
strategies/, references/, skills/, templates/, config/   Project specs
source-documents/    Canonical SMM/PAPA/GUE/FOME source files
archive/             Superseded drafts and one-off extraction scratch work
```

## Run it locally (no cloud account, no cost)

```bash
npm ci && npm --prefix app ci && npm --prefix services/pipeline ci
docker compose up -d                     # PostgreSQL 17 + Cloud Storage emulator
cp app/.env.example app/.env.local
export DATABASE_URL=postgres://hrt:hrt_local_only@127.0.0.1:5432/hrtstocks
npm run db:migrate && npm run seed:system
npx firebase-tools emulators:start --only auth     # separate terminal
npm --prefix app run dev                           # http://localhost:3000
```

Details, first-user creation and running jobs: [docs/gcp/local-development.md](docs/gcp/local-development.md).

## Pages

Dashboard, Buy setup analysis, FOME (single-instrument analysis), Analysis (swing, bullish/bearish), Direction, Indexes, Stock ledger
(with CSV export and per-stock rule trace), News, Strategies (read-only), Data health. Sign-in is **invite-only**.

The Buy Signals, Sell Signals and Backtests pages were removed; see [docs/gcp/README.md](docs/gcp/README.md#removed-features)
for exactly what was removed and what was deliberately kept.

## Testing

```bash
npm test                                            # db migrations + SQL tests, clean-DB smoke, pipeline (incl. end-to-end run), scripts
npm --prefix app run lint && npm --prefix app run typecheck && npm --prefix app test && npm --prefix app run build
```

Database tests use an embedded real PostgreSQL 17; the end-to-end screening test fakes only the NSE and FYERS network calls.

## Why so many NO_DATA results at first?

`config/parameters.yaml` marks RSI period, ADX/DMI period, Bollinger lookback/deviation, volume lookback/multiplier, and pivot
left/right windows as `project_defaults_requiring_backtest`, currently `null`. The project's own `null_policy` forbids assuming a value
for them, so the rule engine routes every rule that needs one to `NO_DATA` or `MANUAL_REVIEW` (as each rule documents) instead of
guessing. GUE's Elliott-wave rules and FOME's derivative rules land there for the same reason. A screen full of `NO_DATA` on day one means
the pipeline is being honest about what the source strategies have not yet pinned down, not that anything is broken.

## Operations

[Deployment](docs/gcp/deployment.md) · [Seed data](docs/gcp/seed-data.md) · [FYERS token rotation](docs/gcp/runbooks/fyers-token.md) · [Operations](docs/gcp/runbooks/operations.md) ·
[User management](docs/gcp/runbooks/user-management.md) · [QA deployment](docs/gcp/runbooks/qa-deployment.md) · [Rollback](docs/gcp/runbooks/rollback.md) ·
[Cost and sizing](docs/gcp/cost-and-sizing.md)

# Seed data

A new database starts **empty of business data**. The only rows that exist before the first pipeline run are the system/reference rows below.
Everything else (instruments, prices, runs, results, rankings, charts, users, watchlists, history) is produced later by fresh NSE/FYERS pipeline runs
and by invitations. No data from any earlier system is loaded.

The seed is **deterministic** (the same inputs always give the same rows), **idempotent** (running it again changes nothing) and **explicit**
(nothing is inserted implicitly by the application). Code: `services/pipeline/src/seed/seed-system.mjs`; tests: `seed-system.test.js`
(empty before, exact table set after, second run identical, invalid e-mail refused, no account created).

## What is seeded, per table

| Table | Rows | Source | Created by | Why it is needed |
|---|---|---|---|---|
| `screening_run_leases` | 2 (`eod_screening`, `buy_setup_analysis`) | the migrations (`0006`, `0012`) | migrations | the run-lease coordination row each pipeline locks; the seed **verifies** they exist and refuses to continue on an unmigrated database |
| `strategy_versions` | one per strategy version | `strategies/*.yaml`, `strategies/shared-gates.yaml` | `seed-strategies.mjs` (called by `seed-system`) | the strategy registry the screening run evaluates against; keyed by `(strategy_id, rule_version)` |
| `rule_definitions` | one per rule | the same YAML files | same | the decision rules (a run records which rule versions it used) |
| `parameter_versions` | one per parameter set | `config/parameters.yaml` | same | versioned parameters referenced by the strategies |
| `bootstrap_admin_emails` | 0 or 1 | the `BOOTSTRAP_ADMIN_EMAIL` environment variable | `seed-system.mjs`, **only when set** | authorizes one e-mail address to become `system_admin` on its first verified sign-in |

Re-running with an unchanged `rule_version` replaces that version's rules (so a typo fix needs no version bump); changing a YAML file and bumping
`rule_version` creates a **new** version and never overwrites the old one (`AGENTS.md`, Change Control).

**Not seeded, on purpose:** `profiles` (a profile is created by an invitation or by the bootstrap sign-in), `instruments`, `index_membership`,
any market bar, run, result, ranking, chart or `stored_objects` row, and any watchlist or history. Screens show an honest empty state until the first run.
The fundamentals tables are not seeded: they are filled only by the (optional) fundamentals refresh, if and when it is used.

## Running it

```bash
# against the Cloud SQL Auth Proxy (see runbooks/qa-deployment.md), after the migrations
DATABASE_URL='postgres://postgres:...@127.0.0.1:5433/hrtstocks' npm run seed:system
# with an administrator authorized (only when an address has been supplied):
DATABASE_URL=... BOOTSTRAP_ADMIN_EMAIL=admin@example.com npm run seed:system
```

Authorizing an e-mail creates **no account**: the person must still be invited (`app/scripts/invite-user.ts`) and sign in with a verified e-mail
([runbooks/user-management.md](runbooks/user-management.md)). When no address is supplied, no administrator exists and no user is created.

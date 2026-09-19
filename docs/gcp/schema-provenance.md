# Schema provenance

The database schema is `db/migrations/0001` … `0021`. **They are the only source of truth for the schema.** A brand-new PostgreSQL
database plus these 21 files, applied in order, is a complete, working system: nothing else is needed to build, test or deploy.

## Where the schema came from

The migrations were originally authored for a hosted Postgres-plus-auth platform and were ported to plain PostgreSQL (Cloud SQL-compatible)
by removing every dependency on that platform: its auth schema, its storage schema, its row-level-security policies, its scheduler
extensions and its role model. What replaced each dependency:

| Original dependency | Replacement in the migrations |
|---|---|
| platform auth schema and JWT helpers | `profiles` keyed by `auth_uid` (the Identity Platform user id); role read from `profiles` |
| row-level-security policies | dropped; authorization is explicit server-side ([authorization.md](authorization.md)) |
| platform storage schema | `stored_objects` registry + a private Cloud Storage bucket |
| scheduler / HTTP / secret-store extensions | none: Cloud Scheduler + Cloud Run Jobs |
| platform roles | `app_web`, `app_pipeline` group roles (`0019_app_roles.sql`), granted to the runtime identities |

The header comment of each ported file says so. The historical hosted project (`miruhnvfkmwffuchqiku`) is **provenance only**: it is named
here so the lineage is documented, and **nothing in this repository connects to it**. No key, password or project reference for it is
needed to build, test or deploy, and none is read by any script.

## Proof that the migrations are self-contained

- `supabase/` (the original migrations and tests) and the porting tooling were **removed** from the repository.
- `db/tests/migrations.test.mjs` applies all 21 files to an empty PostgreSQL 17 (embedded, no platform extensions available), asserts a second run applies nothing, and refuses a modified applied file (checksum).
- `db/tests/clean-db-smoke.test.mjs` re-proves it on a clean database and then starts the **built application** against it.
- `db/tests/sql/*.sql` (pgTAP-style tests, run through a small shim) test functions, views and constraints on that database.
- One legacy test fails identically before and after the port (`bind_fundamental_scores_for_refresh`, "got 1, want 0"); it is allow-listed by name in `db/tests/migrations.test.mjs` (`KNOWN_FAILURES`) and reported, not hidden.

## Extensions

Only `pgcrypto`, which Cloud SQL supports. The clean-database smoke test asserts this is the only extension besides `plpgsql`.

## Changing the schema

Forward-only: add `db/migrations/00NN_description.sql`. An applied file is never edited (the runner checksums applied files and fails on a mismatch).
The operator applies migrations deliberately ([runbooks/qa-deployment.md](runbooks/qa-deployment.md)); no deploy pipeline and no runtime identity has schema-owner rights.

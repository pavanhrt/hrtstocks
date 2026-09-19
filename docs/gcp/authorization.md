# Authorization design

The original hosted platform enforced read access with 63 row-level-security policies and role grants. Cloud SQL has no such layer, so authorization is explicit in
the application and tested against a real PostgreSQL. **Every read goes through a repository that receives the verified viewer**
(`app/src/lib/access.ts` → `currentViewer()`); it throws when nobody is signed in, and no code path takes a role from the browser.

## Roles

`viewer` < `researcher` < `strategy_admin` < `system_admin`. "Staff" means researcher and above.

## Rules (exactly what the policies said)

Implemented in [`app/src/lib/db/visibility.ts`](../../app/src/lib/db/visibility.ts) and applied in SQL by each repository:

| # | Rule | Applies to |
|---|---|---|
| 1 | **Staff only.** Non-staff get empty results (what RLS returned), not errors | `market_bars_*`, `corporate_actions`, `data_quality_results`, `derivative_*`, `pipeline_audit_log`, `pipeline_batches`, `pipeline_persistence_errors`, `analysis_bars`, `screening_run_leases`, rate-limit tables, fundamentals inputs |
| 2 | **Published runs only for viewers**; staff see every run | `screening_runs` and run-scoped tables: `instrument_run_results`, `rule_traces`, `rankings`, `coverage_reconciliation`, direction/pattern/swing/alignment tables, `run_universe_*`, `run_publication_manifests` |
| 3 | **Published enrichment only for viewers** (manifest `published`) | all `buy_setup_*` evidence. The page fails closed: a viewer sees nothing until it is published |
| 4 | **Published fundamentals only for viewers** | fundamentals results/bindings; the ledger exposes `fundamental_result_published` (`0020`) so scores from unpublished manifests are masked and cannot be filtered/sorted on |
| 5 | **Own profile, or admin** | `profiles` (written only by the server: sign-in linking and the invite tool) |
| 6 | Any signed-in user | strategies, rules, parameters, instruments, direction summaries, FOME analyses |

There is no per-user data ownership in this product: authorization is role plus publication state.

## Database roles (defense in depth)

`db/migrations/0019_app_roles.sql` creates two `NOLOGIN` group roles granted to the runtime identities:

- `app_web`: read everything; write `profiles`, create FOME runs, and the news hand-off columns. **Cannot** write pipeline tables or execute pipeline functions.
- `app_pipeline`: full DML and pipeline functions.

A test proves the web role cannot insert into `rankings` or execute `publish_screening_run`.

## What is tested (`app/src/lib/data/authorization.test.ts`, `identity-and-ledger.test.ts`)

Unauthenticated access refused by every repository; viewer vs researcher visibility for runs, ledger, traces, rankings, coverage and tier counts; staff-only tables;
parameterized search and LIKE-wildcard escaping; hostile ids; the identity-linking rules; same-origin enforcement; chart path traversal rejection.

## Other reviewed risks

- **SQL injection:** all reads are parameterized; the old `instruments` search built a PostgREST `.or()` filter from user text (filter injection): fixed. Sort columns come from an allow-list.
- **IDOR:** run and instrument ids are only ever used inside the visibility predicates; `/api/charts/*` serves only paths registered in `stored_objects`.
- **CSRF:** state-changing routes require an `Origin` that exactly equals one configured origin (`APP_BASE_URL`, `ALLOWED_ORIGINS`; no wildcard, no CORS headers), and the session cookie is `SameSite=Lax`. In production with no configured origin every state-changing request is refused.
- **Uploads:** there is no user file upload; only the pipeline writes (generated SVG).

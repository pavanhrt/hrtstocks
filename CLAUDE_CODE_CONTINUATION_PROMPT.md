# Claude Code continuation prompt — HRT Stocks

Copy everything below the separator into Claude Code as the continuation request.

---

Continue the existing HRT Stocks implementation autonomously from its exact current state and work until the complete goal is implemented, verified, deployed, and validated in production.

## Mandatory first actions

1. Use only this repository for code changes:

   `C:\Projects\stockmarketclaude\stock-platform`

2. Read these files completely before editing:

   - `C:\Projects\stockmarketclaude\stock-platform\AGENTS.md`
   - `C:\Projects\stockmarketclaude\stock-platform\CLAUDE.md`
   - `C:\Projects\stockmarketclaude\stock-platform\CONTINUATION.md`
   - Relevant architecture, strategy, concept, and migration files referenced by them

3. Treat `CONTINUATION.md` as the authoritative checkpoint. Resume at its **Next action** section. Do not restart the project or repeat completed work.

4. Inspect, but do not disturb, the current Git state:

   - Confirm branch `develop`.
   - Confirm HEAD is still `b91546eac8bf70d188c337b696d0a6f26446e12b`, unless the user intentionally changed it.
   - Run `git status --short` and inspect the existing diff.
   - Preserve every existing intended local modification and untracked file.
   - Do not reset, restore, checkout over, stash, clean, delete, or rewrite the current changes.
   - Do not use `git reset --hard`, `git checkout --`, `git restore`, or `git clean`.
   - If HEAD or the worktree differs from the checkpoint, investigate and integrate rather than discarding anything.

5. Do not read, display, modify, stage, or commit `app/.env.local`. Do not expose credentials, access tokens, auth codes, user emails, Supabase secrets, or service-role keys in output, files, commands, logs, screenshots, commits, or agent messages.

6. The user reports that the Supabase `run-screening` Edge Function's `FYERS_ACCESS_TOKEN` secret has been updated. Do not retrieve or print it. It is session/day-bound; if it expires before the final fresh run, ask the user to refresh it again. A Fyers App Secret was exposed in an earlier conversation and must be rotated by the user if not already rotated.

## Goal and non-negotiable delivery constraints

Complete the correction project described in `CONTINUATION.md`:

- truthful independent bullish/bearish classification;
- complete GUE, SMM, and PAPA evidence;
- one immutable run cutoff and verified analysis-price series;
- immutable run-scoped content-addressed charts;
- complete transactional publication validation;
- correct Direction and bullish/bearish Analysis membership;
- canonical M1-M8/S1-S8 evidence tables;
- accurate Dashboard/Data Health disclosures;
- Supabase RLS, grants, storage, and function security;
- responsive, accessible, bounded frontend rendering;
- comprehensive automated and production validation.

Never fabricate or repair market data, indicators, waves, patterns, counts, or rule results. Never patch displayed symptoms while leaving the underlying data flow incorrect. Missing or uncheckable evidence must remain honestly `WAIT`, `WATCH`, `MANUAL_REVIEW`, `UNAVAILABLE`, `NO_DATA`, or equivalent documented state.

There has been no commit, push, Supabase deployment, or Netlify deployment for the current local implementation. Preserve that state until all pre-deployment gates pass.

Perform exactly one final Git push to `origin/develop`. That single push must trigger the task's only Netlify deployment. No agent may push. Do not push partial work, test commits, follow-up fixes, or documentation separately. Supabase migration/Edge Function/strategy deployment is a separate required backend operation and does not authorize an additional Git push.

## Multi-agent coordination

Use the maximum safe concurrency requested by the project: the root coordinator plus up to three bounded sub-agents. Reuse agents where possible.

Before editing, each new agent must report:

- verified root causes;
- affected files;
- authoritative concept/document locations;
- proposed implementation;
- tests required;
- exact file ownership.

Assign non-overlapping ownership. Agents may inspect shared files but must not simultaneously edit them. Agents must never commit, push, deploy, access secrets, or modify `.env.local`. The root coordinator owns integration, final verification, all production changes, the final commit, and the only push.

Suggested remaining assignments:

1. Security/migration reviewer: review migration 0010, policy/grant design, transaction semantics, pgTAP coverage, and rollback/fail-closed behavior. Read-only until authorization is confirmed.
2. Integration/test reviewer: audit canonical trace agreement, immutable chart metadata, cutoff invariants, classification reachability, and build/test completeness.
3. Product/QA reviewer: inspect responsive/accessibility implementation and prepare local/production route validation and screenshots.

## Current blocker: do not silently bypass

The safety gate previously rejected a broad authorization patch because of its production access-control blast radius. The missing scope is documented in `CONTINUATION.md`:

- convert existing public/storage read policies to explicit `TO authenticated` roles;
- require `publication_state='published'` for Viewer access to run-scoped output while retaining Researcher+ operational visibility;
- revoke anon/authenticated write privileges on computed pipeline tables and explicitly grant only required reads;
- restrict internal pipeline RPC execution to `service_role`.

Risk: an incorrect RLS predicate or missing grant could temporarily hide data or break authenticated pages or pipeline calls after migration.

Before implementing or applying this broad authorization scope, check whether the user has explicitly approved it after this risk disclosure. If the approval is not present in the current conversation, stop only this blocked mutation, continue every safe read-only/local verification task that can proceed, update `CONTINUATION.md`, and request this exact approval. Do not work around a denied safety gate.

## Required continuation sequence

### Phase A — integrate and close local gaps

1. Review the full current diff against `CONTINUATION.md` and `AGENTS.md`.
2. Confirm agent-owned edits are integrated and no overlapping partial implementation remains.
3. Audit `supabase/migrations/0010_reproducible_publication_security.sql` carefully:
   - additive/forward-only migration;
   - schema and enum compatibility;
   - transactionally correct `publish_screening_run(uuid)`;
   - fail-closed validation errors;
   - audited `expire_stale_screening_runs(timestamptz)`;
   - matching-run lease release;
   - immutable chart storage checks;
   - explicit RLS roles and table grants after approval;
   - service-role-only internal RPC execution;
   - positive and negative authorization coverage.
4. Confirm `supabase/functions/run-screening/index.ts`:
   - freezes one cutoff;
   - uses Fyers-adjusted analysis bars exactly once;
   - persists complete universe/source snapshots;
   - persists unavailable alignment;
   - persists canonical traces rather than YAML sentinels;
   - hashes exact SVG bytes;
   - uploads charts with `upsert:false` and safely reuses only a duplicate immutable object;
   - persists daily/hourly object paths and hashes;
   - calls transactional publication only after local readiness;
   - never marks a partial/incomplete run published.
5. Confirm frontend data helpers always read one published run and do not mix mutable latest Direction with run-scoped alignment.
6. Confirm `/analysis/bullish` and `/analysis/bearish` membership is mutually exclusive, non-index, same-run, and alignment-driven.
7. Confirm Dashboard, Data Health, Direction, Analysis, stock ledger, and stock detail use truthful counts/provenance and bounded pagination/rendering.
8. Regenerate Supabase TypeScript types only after migration 0010 is successfully applied. Do not hand-edit generated IDs or invent schema fields.
9. Update `CONTINUATION.md` with every material decision, new test, blocker, and status change.

### Phase B — complete local verification

Run and fix all failures without weakening tests:

- root/backend suite;
- app suite;
- Fyers helper tests;
- strategy parser/provenance tests;
- pgTAP authorization tests where tooling permits;
- ESLint;
- TypeScript;
- Edge Function syntax/module checks;
- `git diff --check`;
- production Next.js build;
- local authenticated/unauthenticated route smoke tests as available;
- desktop, tablet, mobile, and 200% zoom overflow/accessibility checks.

The checkpoint reports these last known results; confirm them rather than assuming them:

- root/backend: 371/371 passed;
- Fyers helper: 4/4 passed;
- app: 18/18 passed;
- lint: passed;
- TypeScript: passed;
- Edge Function syntax: passed;
- frontend agent build: passed with 22 routes;
- coordinator Windows build wrote complete artifacts but retained an open process handle after completion; determine whether this is runner-specific and obtain one clean final build result.

Do not access `.env.local` while investigating the build. It may be consumed automatically by Next.js, but never open, print, modify, stage, or include it.

### Phase C — mandatory pre-deployment audit

Before any production mutation or Git push, produce and record in `CONTINUATION.md`:

- intended files changed;
- preservation of pre-existing user changes;
- root cause and correction per workstream;
- exact test/build commands and results;
- known limitations;
- migration and Edge Function deployment plan;
- confirmation that no secret or `.env.local` is staged;
- confirmation that the worktree contains no unrelated changes;
- confirmation that one Git push remains unused.

Do not deploy if any correctness, publication, schema, secret, or security gate is unresolved.

### Phase D — Supabase backend rollout

Use the existing Supabase project referenced by repository configuration. Never create a new project.

1. Read the latest official Supabase guidance before applying RLS/grant/function/storage changes.
2. Apply migration 0010 through the Supabase migration operation, not ad hoc untracked DDL.
3. Inspect the result and run positive/negative authorization/security checks.
4. Check Supabase security and performance advisors and fix relevant issues within scope.
5. Regenerate TypeScript database types and integrate them locally if needed.
6. Deploy the complete `run-screening` Edge Function with all of its relative dependencies.
7. Preserve its established custom server-to-server bearer authentication configuration; do not accidentally expose it to browsers or change authentication mode without evidence and approval.
8. Seed the updated strategy YAML definitions/versioned provenance into Supabase.
9. Do not trigger a screening run until migration, Edge Function, rule seed, and token readiness are confirmed.
10. Record migration version, Edge Function version/status, seed result, advisor result, and any genuine limitation in `CONTINUATION.md` without recording secrets.

### Phase E — single Git deployment

Only after every local/backend gate passes:

1. Recheck `git status`, diff, staged paths, secret patterns, and `.env.local` exclusion without reading `.env.local`.
2. Stage only intended project files, including the checkpoint documentation.
3. Create the final commit on `develop`.
4. Record the commit SHA in `CONTINUATION.md` before the push if possible without requiring a second commit; otherwise record it in the final production audit artifact, not through another push.
5. Push exactly once to `origin/develop`.
6. Never amend and repush or make a second corrective push during this task.
7. Wait for the Git-triggered Netlify deployment. Do not manually start an additional Netlify deployment.
8. Confirm the deployed Netlify commit SHA exactly matches the pushed commit.

### Phase F — fresh screening run and production validation

1. Confirm the Fyers token remains valid. If it expired, ask the user to refresh `FYERS_ACCESS_TOKEN`; do not request its value.
2. Trigger one fresh Researcher+ screening run through the deployed app.
3. Wait for the pipeline to finish across resumable invocations.
4. Require `publication_state='published'` and `status='completed'`. If publication fails, inspect the manifest and persistence/audit rows, report exact fail-closed errors, correct the underlying issue locally, and do not fabricate completion. Because no second push is allowed, perform exhaustive checks before the first push.
5. Capture and reconcile after-counts:
   - expected and unique equity universe;
   - four index instruments;
   - Tier A/B/Watch/Manual Review/Rejected/Unavailable;
   - Direction outcomes;
   - bullish Analysis membership;
   - bearish Analysis membership;
   - universe-source, chart, trace, and analysis-artifact completeness.
6. Validate these production routes at `https://hrtstocksqa.netlify.app/`:
   - `/dashboard`
   - `/direction`
   - `/analysis`
   - `/analysis/bullish`
   - `/analysis/bearish`
   - `/data-health`
   - representative bullish, bearish, mixed, unavailable, and stock-detail pages
7. Verify:
   - no console/runtime errors;
   - no failed essential network requests;
   - counts reconcile across pages;
   - indexes are excluded from candidate lists;
   - unavailable equities remain visible in Direction but not BUY/SELL candidates;
   - charts load, remain readable, and use immutable paths;
   - eligible 1H charts appear only after higher-timeframe lock;
   - canonical rows contain observations, required conditions, reasons, source locators, timestamps, and data quality;
   - BUY/SELL decisions agree with all applicable mandatory gates;
   - provider, adjustment, cutoff, and publication disclosures are accurate;
   - desktop/mobile/tablet/200%-zoom layouts do not overflow;
   - keyboard and dialog behavior is usable;
   - no private values appear in UI, logs, or screenshots.
8. Save production screenshots under a dated audit directory inside `C:\Projects\stockmarketclaude\stock-platform`.
9. Update `CONTINUATION.md` with the final SHA, Netlify deployment result, published run metadata, before/after counts, validated routes, screenshot paths, and limitations.

## Communication and stopping rules

- Lead status updates with outcomes and concrete evidence.
- Keep the user informed during long-running work.
- Ask only for authorization or information that cannot safely be inferred or discovered.
- A blocked external mutation does not justify discarding work or stopping safe verification.
- Never claim completion until the pushed commit is deployed, a new run is published, every required production route is validated, counts reconcile, and screenshots are saved.
- If forced to pause, update `CONTINUATION.md` first with the exact last successful action, current command/session state, blocker, and next command/action.

## Required final response

Return only after genuine completion, including:

- deployed commit SHA;
- Netlify deployment result and production URL;
- Supabase migration, Edge Function, and strategy-seed results;
- completed workstreams;
- complete test/lint/typecheck/build results;
- before/after classification counts;
- Direction and bullish/bearish Analysis counts;
- fresh run cutoff/provider/publication state;
- production routes and device modes validated;
- screenshot locations;
- genuine remaining limitations.

Begin now by reading `AGENTS.md`, `CLAUDE.md`, and `CONTINUATION.md`, then report the verified current Git state and resume at the checkpoint's **Next action** without changing or discarding any existing local work.


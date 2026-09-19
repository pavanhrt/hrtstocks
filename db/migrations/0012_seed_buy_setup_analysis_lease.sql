-- Originally authored for Supabase; made self-contained for plain PostgreSQL / Cloud SQL (see docs/gcp/schema-provenance.md).
-- Supabase-only statements (RLS, policies, role grants, auth/storage/cron) were removed or replaced.

-- Fixes a deployment bug found while running the analyze-buy-setup Edge
-- Function for the first time (2026-09-15): migration 0011 introduced
-- run_type='buy_setup_analysis' as a value passed to acquireRunLease()
-- (run-lease.js), but never seeded the corresponding row in
-- screening_run_leases -- unlike migration 0006, which explicitly seeded
-- 'eod_screening''s own row for the exact same reason (see 0006's own
-- comment on that table: "one row per run_type").
--
-- acquireRunLease() claims a lease with a plain
-- `UPDATE ... WHERE run_type = $1 AND (status='released' OR expired)`
-- (run-lease.js) -- an UPDATE can only ever affect an EXISTING row, never
-- insert a new one. With no 'buy_setup_analysis' row present, that UPDATE
-- permanently matches zero rows, so `acquired` is always false and
-- analyze-buy-setup's Deno.serve handler always returns
-- {status: "processing", note: "An enrichment invocation is already active
-- for this run."} without ever creating a manifest or doing any work --
-- confirmed live: triggering the function against a real published run
-- returned exactly that response, and screening_run_leases had no
-- 'buy_setup_analysis' row at all.
insert into screening_run_leases (run_type, status) values ('buy_setup_analysis', 'released')
on conflict (run_type) do nothing;
-- Adds swing_analysis_results.combination_matrix, which migration 0006's own
-- file already declared (added during the ADX/DMI-conflict resolution pass,
-- see that file's own comment on the column) but which was never actually
-- deployed to the live database -- a gap that went unnoticed until the first
-- real screening run after Correction Cycle 2 (2026-09-11) hit it: every
-- swing_analysis_results upsert failed with a real (non-"table missing")
-- Postgrest error for every instrument, silently caught and logged as a
-- warning by index.ts's own try/catch, so the whole WBP-/WSP- swing-gate
-- pipeline (including the new M5-M8 BUY/SELL logic) produced zero rows that
-- run even though instrument_run_results/tier/rank were unaffected.
--
-- Applied live via Supabase MCP execute path immediately on discovery
-- (2026-09-11), with explicit user authorization ("1 is done"); this file
-- records that same change for the local migration history so
-- `supabase db diff`/a fresh environment stays consistent with what's live.

alter table swing_analysis_results add column if not exists combination_matrix jsonb;

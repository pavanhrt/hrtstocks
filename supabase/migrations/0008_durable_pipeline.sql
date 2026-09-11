-- Wires up the durable, resumable, chunked screening-run pipeline that
-- migration 0006's pipeline_batches table was drafted for but that no
-- application code has ever read or written (confirmed via a repo-wide
-- grep before writing this). Closes the core dishonesty bug reported
-- 2026-09-11: a run that only ever attempts 14 of 501 instruments (the rest
-- bulk-inserted as a fake terminal NO_DATA once index.ts's 125s internal
-- time budget ran out) was still rendering as COMPLETED, because
-- reconcile.js's reconcileCoverage() only checks that whatever results
-- *were* collected sum to a consistent tier count -- it has no notion of
-- the expected universe size, so a fabricated 501-length array (14 real +
-- 487 fake-unavailable) trivially "reconciles." The real fix is a
-- pipeline_batches-backed "did every expected instrument get a genuine
-- attempt" gate (see pipeline/run-status.js), which this migration's two
-- new functions make possible to implement atomically and idempotently
-- across many Edge Function invocations.
--
-- NOT auto-applied by writing this file -- applied via the same
-- execute_sql/apply_migration path already used for every prior migration
-- this session, after local review.

-- ---------------------------------------------------------------------------
-- Atomic, idempotent batch claiming
-- ---------------------------------------------------------------------------

-- PostgREST/supabase-js's query builder cannot express
-- `UPDATE ... WHERE id = (SELECT ... FOR UPDATE SKIP LOCKED)`, so this has to
-- be a real function. `returns setof` (0 or 1 rows), not a single composite
-- row -- matching this codebase's own established RPC convention
-- (try_acquire_rate_limit_slot, migration 0007, `returns table(...)`):
-- supabase-js callers here treat every RPC result as an array (`data[0]`),
-- never `.single()`/`.maybeSingle()`, which are for `.select()` responses.
-- A plain `language sql` function with `UPDATE ... RETURNING *` already
-- returns exactly the right shape (0 rows if nothing was eligible to claim,
-- 1 row otherwise) with no plpgsql/variables needed. No SECURITY DEFINER:
-- the only caller is the Edge Function's own service/secret-role client,
-- which already bypasses RLS on pipeline_batches, same trust boundary as
-- every other write in this pipeline.
--
-- Claim order: universe -> incremental -> reconcile -> backfill. Two
-- separate mechanisms work together here, not one:
--   1. The `reconcile` branch is a WHERE-clause `not exists`, not just ORDER
--      BY priority -- it controls *eligibility*: reconcile is not even a
--      candidate row until every universe/incremental batch for the run is
--      no longer pending/in_progress.
--   2. Once eligible, reconcile is given a LOWER priority number than
--      backfill (2 vs 3), not higher -- backfill batches never gate
--      eligibility (they have no such guard, they're always a candidate),
--      so if backfill outranked reconcile in the ORDER BY, a run with many
--      backfill chunks still pending (e.g. a first-ever run backfilling
--      most of the universe) would keep this function handing out backfill
--      work forever and never let reconcile through, even though
--      pipeline/run-status.js's decideRunStatus() never lets backfill block
--      completion -- the two would contradict each other. Ranking reconcile
--      above backfill means a run concludes (completed/partial) promptly
--      once its real coverage work is done, and any remaining backfill
--      chunks keep getting claimed and processed in later loop iterations
--      as a background enrichment, independent of the run's own status.
create or replace function claim_next_pipeline_batch(p_run_id uuid)
returns setof pipeline_batches
language sql
as $$
  update pipeline_batches
  set status = 'in_progress', attempt = attempt + 1, updated_at = now()
  where id = (
    select id from pipeline_batches
    where run_id = p_run_id
      and status = 'pending'
      and (
        stage in ('universe', 'incremental', 'backfill')
        or (stage = 'reconcile' and not exists (
          select 1 from pipeline_batches pb2
          where pb2.run_id = p_run_id and pb2.stage in ('universe', 'incremental')
            and pb2.status in ('pending', 'in_progress')
        ))
      )
    order by case stage when 'universe' then 0 when 'incremental' then 1
                         when 'reconcile' then 2 when 'backfill' then 3 end, id
    limit 1
    for update skip locked
  )
  returning *;
$$;

comment on function claim_next_pipeline_batch is
  'Atomically claims and marks in_progress the next eligible pending pipeline_batches '
  'row for a run (FOR UPDATE SKIP LOCKED -- safe even if two invocations somehow call '
  'this concurrently for the same run, though in normal operation the screening_run_leases '
  'lease already ensures only one invocation processes a run''s batches at a time). Returns '
  'zero rows (not null/error) when nothing is currently eligible to claim.';

-- ---------------------------------------------------------------------------
-- Stuck-batch recovery
-- ---------------------------------------------------------------------------

-- Resets a batch an invocation claimed but never finished (that invocation
-- was hard-killed or crashed) back to 'pending' so a future invocation can
-- retry it -- or, once its own attempt budget is exhausted, marks it
-- permanently 'failed' so processReconcileBatch can insert honest "gave up"
-- terminal rows for its instruments instead of retrying forever. Called
-- once per invocation, before claiming a new batch (see index.ts).
create or replace function reset_stale_pipeline_batches(p_run_id uuid, p_stale_after_seconds integer, p_max_attempts integer)
returns setof pipeline_batches
language sql
as $$
  update pipeline_batches
  set
    status = case when attempt >= p_max_attempts then 'failed' else 'pending' end,
    last_error = case when attempt >= p_max_attempts
      then coalesce(last_error, '') || format(' [gave up after %s attempts, last claimed %s]', attempt, updated_at)
      else last_error end,
    updated_at = now()
  where run_id = p_run_id
    and status = 'in_progress'
    and updated_at < now() - make_interval(secs => p_stale_after_seconds)
  returning *;
$$;

comment on function reset_stale_pipeline_batches is
  'Reclaims pipeline_batches rows left in_progress by a dead invocation. '
  'p_stale_after_seconds should be comfortably longer than one healthy chunk''s own '
  'processing time (a ~60-instrument chunk, ~40-50s worst case) -- 240s (4 minutes) is '
  'the value index.ts uses, matching the shortened 3-minute eod_screening lease duration '
  'with real margin.';

-- ---------------------------------------------------------------------------
-- Ranking reconstruction across invocations
-- ---------------------------------------------------------------------------

-- rankWithinTiers() (rank.js) needs each tier_a/tier_b instrument's
-- component-score breakdown, previously only ever held in one invocation's
-- own in-memory loop (evaluateInstrument -> the same request's final
-- ranking step). Now that an instrument's evaluation and the run's final
-- reconcile/ranking step can happen in different Edge Function invocations
-- (different isolates, no shared memory), the breakdown has to be persisted
-- alongside the result it was computed for, not recomputed by re-deriving
-- it from rule_traces (which would mean re-implementing scoreComponents'
-- exact grouping logic a second time, in SQL, with no test coverage).
alter table instrument_run_results add column if not exists component_scores jsonb;

-- ---------------------------------------------------------------------------
-- Supporting indexes
-- ---------------------------------------------------------------------------

-- The incremental fetch (fyers.js's nextIncrementalRange) needs "what's the
-- latest daily bar already stored for this instrument" on every processed
-- instrument, every run.
create index if not exists market_bars_raw_instrument_interval_session_date_idx
  on market_bars_raw (instrument_id, interval, session_date desc);

-- Idempotent-retry cleanup (index.ts deletes an instrument's own
-- data_quality_results before re-writing them, closing the narrow window
-- where a process dies after those writes but before instrument_run_results).
create index if not exists data_quality_results_run_instrument_idx
  on data_quality_results (run_id, instrument_id);

-- ---------------------------------------------------------------------------
-- Recovery-sweep cron job (confirmed with the project owner before including
-- this: it only acts on runs already started manually via the dashboard --
-- it never initiates a new run on its own, so it is a fast no-op query
-- whenever nothing is in flight). This is NOT the standing daily
-- auto-trigger cron README.md describes -- that stays unscheduled, a
-- separate, later, explicitly-authorized step.
-- ---------------------------------------------------------------------------

-- One-time manual step (NOT done by this migration -- never put a real
-- secret in a migration file): before this job can actually fire a request,
-- run once via the SQL editor:
--   select vault.create_secret('<the same value as SUPABASE_SECRET_KEYS''s
--     "default" entry, used as the Edge Function''s own bearer auth>',
--     'run_screening_bearer_secret');
-- The job below reads it by name at call time via vault.decrypted_secrets,
-- so the secret itself is never stored in cron.job's own (readable) source.
select cron.schedule(
  'eod-screening-recovery-sweep',
  '* * * * *',
  $$
  select net.http_post(
    url := 'https://yqxpucjtzrmwjniruebt.supabase.co/functions/v1/run-screening',
    headers := jsonb_build_object(
      'Authorization', 'Bearer ' || (
        select decrypted_secret from vault.decrypted_secrets where name = 'run_screening_bearer_secret'
      ),
      'Content-Type', 'application/json'
    ),
    body := jsonb_build_object('trigger_type', 'scheduled', 'resume_run_id', r.id)
  )
  from screening_runs r
  where r.status in ('queued', 'running')
    and exists (
      select 1 from pipeline_batches pb
      where pb.run_id = r.id and pb.stage in ('universe', 'incremental', 'backfill', 'reconcile')
        and pb.status in ('pending', 'in_progress')
    )
    and exists (
      select 1 from screening_run_leases l
      where l.run_type = 'eod_screening'
        and (l.status = 'released' or l.expires_at < now())
    )
  limit 1;
  $$
);

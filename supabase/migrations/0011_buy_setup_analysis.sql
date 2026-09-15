-- Buy Setup Analysis (/buy-setup-analysis page) -- run-scoped schema for the
-- three-timeframe gate's downstream 15-minute enrichment stage.
--
-- REVISED 2026-09-15 (never applied to any live database -- safe to revise
-- directly rather than layering a 0012 patch): the original version of this
-- migration had analyze-buy-setup writing into shared canonical tables
-- (rule_traces, pattern_detections, analysis_bars, elliott_hypotheses),
-- including DELETING existing daily pattern_detections rows -- a mutation of
-- an already-published screening run's own snapshot. That violates
-- AGENTS.md's own immutability guarantee and this migration's own stated
-- design goal ("a partial 15-minute result must not corrupt or overwrite an
-- already published snapshot"). Every one of those four tables now has a
-- dedicated, enrichment-owned equivalent below; analyze-buy-setup writes to
-- NONE of the four canonical tables and reads them read-only.
--
-- Transactional design: a SEPARATELY PUBLISHED ENRICHMENT STAGE, not part of
-- the main publish_screening_run() contract.
--   1. Only ever runs against a run whose screening_runs.publication_state
--      is already 'published' -- refuses otherwise.
--   2. Never writes to screening_runs, instrument_run_results,
--      coverage_reconciliation, run_publication_manifests, rule_traces,
--      pattern_detections, analysis_bars, or elliott_hypotheses -- only to
--      the buy_setup_* tables below, gated by their own
--      buy_setup_manifests.enrichment_state, so a partial/failed enrichment
--      structurally cannot corrupt or hide the already-published main
--      snapshot.
--   3. publish_buy_setup_enrichment(p_run_id) (below) is the ONLY code
--      allowed to flip enrichment_state to 'published', mirroring
--      publish_screening_run()'s own role for the main run -- it locks the
--      manifest row, re-validates the full snapshot, and only then flips
--      state, exactly like the main publish RPC.
--
-- Durable pipeline: mirrors run-screening's own pipeline_batches design
-- (migration 0008) at a smaller scale -- buy_setup_pipeline_batches below,
-- claimed atomically, with bounded attempts, stale-batch recovery, and a
-- lease (screening_run_leases, reused with run_type='buy_setup_analysis').
--
-- Every table is gated for SELECT the same way run_universe_sources/
-- analysis_bars/run_publication_manifests already are in 0010 (Viewer sees
-- rows only once buy_setup_manifests.enrichment_state = 'published';
-- Researcher+ can inspect an in-progress or failed enrichment). Writes are
-- service-role-only (RLS grants SELECT only; INSERT/UPDATE/DELETE are never
-- granted to anon/authenticated).

-- ---------------------------------------------------------------------------
-- Enrichment manifest: one row per screening run this stage has ever been
-- attempted for. Pins the EXACT rule_version/parameter_version this
-- enrichment ran under (parameter_version_id is a real FK to
-- parameter_versions, not just a copied string) so a later change to the
-- active configuration can never retroactively change what an
-- already-started or already-published run is recorded as having used.
-- ---------------------------------------------------------------------------

create table buy_setup_manifests (
  run_id uuid primary key references screening_runs(id) on delete cascade,
  enrichment_state text not null check (
    enrichment_state in ('pending', 'processing', 'validated', 'validation_failed', 'published')
  ),
  strategy_version_id uuid references strategy_versions(id),
  rule_version text not null,
  parameter_version_id uuid references parameter_versions(id),
  parameter_version text not null,
  expected_equity_count integer not null default 0,
  qualified_count integer not null default 0,
  fifteen_minute_completed_count integer not null default 0,
  manual_review_count integer not null default 0,
  no_data_count integer not null default 0,
  error_count integer not null default 0,
  validation_errors jsonb not null default '[]',
  triggered_by uuid references profiles(id),
  computed_at timestamptz not null default now(),
  validated_at timestamptz,
  published_at timestamptz
);

-- ---------------------------------------------------------------------------
-- Durable batching -- same shape and claim semantics as pipeline_batches
-- (migration 0008), scoped to this enrichment. 'gate' batches cover the
-- complete stock universe (every equity gets a three-timeframe-gate
-- attempt); 'fifteen_minute' batches are only ever created for instruments
-- that already passed the gate.
-- ---------------------------------------------------------------------------

create table buy_setup_pipeline_batches (
  id bigint generated always as identity primary key,
  run_id uuid not null references screening_runs(id) on delete cascade,
  stage text not null check (stage in ('gate', 'fifteen_minute')),
  cursor text, -- JSON array of instrument ids, same convention as pipeline_batches.cursor
  attempt integer not null default 0,
  status text not null default 'pending' check (status in ('pending', 'in_progress', 'done', 'failed')),
  last_error text,
  updated_at timestamptz not null default now()
);
create index buy_setup_pipeline_batches_claim_idx on buy_setup_pipeline_batches (run_id, stage, status);

create or replace function claim_next_buy_setup_batch(p_run_id uuid)
returns setof buy_setup_pipeline_batches
language sql
as $$
  update buy_setup_pipeline_batches
  set status = 'in_progress', attempt = attempt + 1, updated_at = now()
  where id = (
    select id from buy_setup_pipeline_batches
    where run_id = p_run_id
      and status = 'pending'
      and (
        stage = 'gate'
        or (stage = 'fifteen_minute' and not exists (
          select 1 from buy_setup_pipeline_batches pb2
          where pb2.run_id = p_run_id and pb2.stage = 'gate' and pb2.status in ('pending', 'in_progress')
        ))
      )
    order by case stage when 'gate' then 0 when 'fifteen_minute' then 1 end, id
    limit 1
    for update skip locked
  )
  returning *;
$$;

create or replace function reset_stale_buy_setup_batches(p_run_id uuid, p_stale_after_seconds integer, p_max_attempts integer)
returns setof buy_setup_pipeline_batches
language sql
as $$
  update buy_setup_pipeline_batches
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

-- ---------------------------------------------------------------------------
-- Explicit persistence-error records -- mirrors pipeline_persistence_errors
-- (0010), scoped to this enrichment. A recorded row here is a CRITICAL
-- failure for a specific instrument/stage and blocks publication for that
-- instrument's expected evidence (see publish_buy_setup_enrichment below).
-- ---------------------------------------------------------------------------

create table buy_setup_persistence_errors (
  id bigint generated always as identity primary key,
  run_id uuid not null references screening_runs(id) on delete cascade,
  instrument_id text not null references instruments(id),
  stage text not null check (stage in ('gate', 'daily_patterns', 'daily_ema', 'chart_levels', 'daily_chart', 'fifteen_minute_bars', 'intraday_indicators', 'fifteen_minute_wave', 'divergence', 'intraday_chart')),
  error_message text not null,
  created_at timestamptz not null default now()
);
create index buy_setup_persistence_errors_lookup on buy_setup_persistence_errors (run_id, instrument_id);

-- ---------------------------------------------------------------------------
-- BSA gate traces -- dedicated equivalent of rule_traces, NEVER written into
-- the canonical rule_traces table (which belongs exclusively to the main
-- published run's own SMM/PAPA/GUE/FOME/BSP/SSP/WBP/WSP evaluation).
-- ---------------------------------------------------------------------------

create table buy_setup_gate_traces (
  id bigint generated always as identity primary key,
  run_id uuid not null references screening_runs(id) on delete cascade,
  instrument_id text not null references instruments(id),
  rule_id text not null check (rule_id in ('BSA-D1', 'BSA-G1')),
  rule_version text not null,
  parameter_version text not null,
  observed_values jsonb not null default '{}',
  thresholds jsonb not null default '{}',
  result rule_result not null,
  explanation text,
  source_status text not null default 'PROJECT_DEFAULT',
  source_locator text not null default 'strategies/buy-setup-analysis.yaml decision record (2026-09-15)',
  computed_at timestamptz not null default now(),
  unique (run_id, instrument_id, rule_id)
);
create index buy_setup_gate_traces_lookup on buy_setup_gate_traces (run_id, rule_id, result);

-- ---------------------------------------------------------------------------
-- Daily candlestick and chart-pattern detections -- dedicated equivalents of
-- pattern_detections, kept as TWO SEPARATE tables (never merged into one
-- array/one row reused for two different UI columns). Support multiple
-- detections per instrument.
-- ---------------------------------------------------------------------------

create table buy_setup_candlestick_detections (
  id bigint generated always as identity primary key,
  run_id uuid not null references screening_runs(id) on delete cascade,
  instrument_id text not null references instruments(id),
  pattern_name text not null,
  direction text not null check (direction in ('bullish', 'bearish')),
  state text not null check (state in ('OBSERVED', 'TRIGGERED', 'FAILED', 'HISTORICAL', 'MANUAL_REVIEW')),
  lifecycle_state text,
  confidence text not null default 'deterministic',
  anchor_points jsonb not null default '[]',
  trigger_bar_ts timestamptz,
  target_price numeric,
  invalidation_price numeric,
  volume_evidence jsonb,
  source_locator text not null,
  computed_at timestamptz not null default now()
);
create index buy_setup_candlestick_detections_lookup on buy_setup_candlestick_detections (run_id, instrument_id, state);

create table buy_setup_chart_pattern_detections (
  id bigint generated always as identity primary key,
  run_id uuid not null references screening_runs(id) on delete cascade,
  instrument_id text not null references instruments(id),
  pattern_name text not null,
  direction text not null check (direction in ('bullish', 'bearish')),
  state text not null check (state in ('OBSERVED', 'TRIGGERED', 'FAILED', 'HISTORICAL', 'MANUAL_REVIEW')),
  lifecycle_state text,
  confidence text not null default 'deterministic',
  anchor_points jsonb not null default '[]',
  trigger_bar_ts timestamptz,
  target_price numeric,
  invalidation_price numeric,
  volume_evidence jsonb,
  source_locator text not null,
  computed_at timestamptz not null default now()
);
create index buy_setup_chart_pattern_detections_lookup on buy_setup_chart_pattern_detections (run_id, instrument_id, state);

-- Detector coverage disclosure -- lets the UI say "none among implemented
-- detectors" rather than implying exhaustive coverage. One row per run
-- (coverage is a property of the code version that ran, not the instrument).
create table buy_setup_pattern_detector_coverage (
  run_id uuid primary key references screening_runs(id) on delete cascade,
  candlestick_implemented text[] not null default '{}',
  candlestick_not_evaluated text[] not null default '{}',
  chart_pattern_implemented text[] not null default '{}',
  chart_pattern_not_evaluated text[] not null default '{}',
  computed_at timestamptz not null default now()
);

-- ---------------------------------------------------------------------------
-- Daily and 15-minute EMA positive crossover evidence.
-- ---------------------------------------------------------------------------

create table buy_setup_ema_crossover (
  id bigint generated always as identity primary key,
  run_id uuid not null references screening_runs(id) on delete cascade,
  instrument_id text not null references instruments(id),
  timeframe text not null check (timeframe in ('daily', '15m')),
  fast_period integer not null,
  slow_period integer not null,
  fast_value numeric,
  slow_value numeric,
  fast_previous numeric,
  slow_previous numeric,
  crossover_bar_ts timestamptz,
  status text not null check (status in ('TRIGGERED', 'ALREADY_ABOVE', 'NOT_TRIGGERED', 'NO_DATA')),
  confirmation_window integer not null,
  parameter_version text not null,
  computed_at timestamptz not null default now(),
  unique (run_id, instrument_id, timeframe, slow_period)
);
create index buy_setup_ema_crossover_lookup on buy_setup_ema_crossover (run_id, instrument_id, timeframe);

-- ---------------------------------------------------------------------------
-- Daily chart structure: support/resistance, breakout, channel/range.
-- ---------------------------------------------------------------------------

create table buy_setup_chart_levels (
  run_id uuid not null references screening_runs(id) on delete cascade,
  instrument_id text not null references instruments(id),
  support_level numeric,
  support_touch_count integer,
  resistance_level numeric,
  resistance_touch_count integer,
  breakout_detected boolean,
  breakout_candle_ts timestamptz,
  breakout_volume_confirmed boolean,
  channel_type text check (channel_type in ('rising', 'falling', 'sideways', 'NOT_APPLICABLE')),
  channel_upper numeric,
  channel_lower numeric,
  pivot_left_window integer not null,
  pivot_right_window integer not null,
  parameter_version text not null,
  computed_at timestamptz not null default now(),
  primary key (run_id, instrument_id)
);

-- ---------------------------------------------------------------------------
-- 15-minute OHLCV bars -- dedicated equivalent of analysis_bars, never
-- written into the canonical table (which is scoped to the main run's own
-- 1d/1h series). Same column shape for easy reuse of existing
-- render/feature code that expects {date/ts, open, high, low, close,
-- volume}.
-- ---------------------------------------------------------------------------

create table buy_setup_fifteen_minute_bars (
  run_id uuid not null references screening_runs(id) on delete cascade,
  instrument_id text not null references instruments(id),
  session_date date not null,
  ts timestamptz not null,
  open numeric not null check (open > 0),
  high numeric not null check (high > 0),
  low numeric not null check (low > 0),
  close numeric not null check (close > 0),
  volume numeric not null check (volume >= 0),
  provider text not null,
  adjustment_state text not null,
  algorithm_version text not null,
  provenance jsonb not null,
  is_complete boolean not null default true,
  source_retrieved_at timestamptz,
  created_at timestamptz not null default now(),
  primary key (run_id, instrument_id, ts)
);
create index buy_setup_fifteen_minute_bars_session_idx on buy_setup_fifteen_minute_bars (run_id, instrument_id, session_date);

-- ---------------------------------------------------------------------------
-- 15-minute technical-feature evidence (RSI, Stochastic, Bollinger, DMI/ADX,
-- MACD). One row per instrument per run -- the latest complete-candle
-- reading.
-- ---------------------------------------------------------------------------

create table buy_setup_intraday_indicators (
  run_id uuid not null references screening_runs(id) on delete cascade,
  instrument_id text not null references instruments(id),
  evidence_candle_ts timestamptz,
  rsi numeric,
  rsi_previous numeric,
  stochastic_k numeric,
  stochastic_d numeric,
  stochastic_k_previous numeric,
  stochastic_d_previous numeric,
  bollinger_upper numeric,
  bollinger_middle numeric,
  bollinger_lower numeric,
  bollinger_status text check (bollinger_status in ('above_upper', 'within_bands', 'below_lower', 'NO_DATA')),
  plus_di numeric,
  minus_di numeric,
  adx numeric,
  macd_line numeric,
  macd_signal numeric,
  macd_histogram numeric,
  macd_histogram_previous numeric,
  parameter_version text not null,
  computed_at timestamptz not null default now(),
  primary key (run_id, instrument_id)
);

-- ---------------------------------------------------------------------------
-- 15-minute GUE/Elliott wave assessment -- dedicated equivalent of
-- elliott_hypotheses, never written into the canonical table (scoped to the
-- main run's daily/weekly/monthly Direction feature).
-- ---------------------------------------------------------------------------

create table buy_setup_fifteen_minute_wave (
  id bigint generated always as identity primary key,
  run_id uuid not null references screening_runs(id) on delete cascade,
  instrument_id text not null references instruments(id),
  structure_type text check (structure_type in ('impulse', 'zigzag', 'flat', 'triangle', 'ending_diagonal', 'leading_diagonal', 'combination')),
  current_wave text,
  wave_state text check (wave_state in ('forming', 'completed')),
  confidence text not null check (confidence in ('confirmed', 'tentative', 'unconfirmed')),
  rule_arithmetic jsonb not null default '{}',
  rule_evidence jsonb not null default '[]',
  invalidation_price numeric,
  invalidation_condition text,
  reason text,
  source_locator text not null default 'supabase/functions/run-screening/buy-setup/fifteen-minute-wave.js (reuses features/wave.js GUE-IMPULSE-001/002/003)',
  computed_at timestamptz not null default now(),
  unique (run_id, instrument_id)
);

-- ---------------------------------------------------------------------------
-- RSI and MACD-histogram bullish divergence evidence, kept as two
-- independent rows per instrument (never merged into one aggregate verdict).
-- ---------------------------------------------------------------------------

create table buy_setup_divergence_evidence (
  id bigint generated always as identity primary key,
  run_id uuid not null references screening_runs(id) on delete cascade,
  instrument_id text not null references instruments(id),
  indicator text not null check (indicator in ('rsi', 'macd_histogram')),
  price_pivot_1_ts timestamptz,
  price_pivot_1_value numeric,
  price_pivot_2_ts timestamptz,
  price_pivot_2_value numeric,
  indicator_pivot_1_value numeric,
  indicator_pivot_2_value numeric,
  result text not null check (result in ('PASS', 'FAIL', 'NOT_APPLICABLE', 'NO_DATA')),
  reason text,
  parameter_version text not null,
  computed_at timestamptz not null default now(),
  unique (run_id, instrument_id, indicator)
);
create index buy_setup_divergence_evidence_lookup on buy_setup_divergence_evidence (run_id, instrument_id);

-- ---------------------------------------------------------------------------
-- Immutable, content-addressed chart metadata -- same convention as
-- instrument_direction_runs' chart_object_path/chart_content_hash/
-- chart_algorithm_version (0006), stored in the same 'direction-charts'
-- storage bucket with the same upsert:false semantics (enforced by the
-- Edge Function, not by this schema).
-- ---------------------------------------------------------------------------

create table buy_setup_charts (
  run_id uuid not null references screening_runs(id) on delete cascade,
  instrument_id text not null references instruments(id),
  timeframe text not null check (timeframe in ('daily', '15m')),
  chart_object_path text not null,
  chart_content_hash text not null check (chart_content_hash ~ '^[a-f0-9]{64}$'),
  chart_algorithm_version text not null,
  computed_at timestamptz not null default now(),
  primary key (run_id, instrument_id, timeframe)
);

-- ---------------------------------------------------------------------------
-- Transactional enrichment publication -- the ONLY code allowed to flip
-- buy_setup_manifests.enrichment_state to 'published'. Mirrors
-- publish_screening_run()'s own shape: lock, validate, write a manifest of
-- exactly what was checked, flip state only if every check passes.
-- ---------------------------------------------------------------------------

create or replace function publish_buy_setup_enrichment(p_run_id uuid)
returns jsonb
language plpgsql
set search_path to 'public', 'pg_temp'
as $function$
declare
  v_manifest buy_setup_manifests%rowtype;
  v_expected_equities integer;
  v_gate_rows integer;
  v_gate_pass integer;
  v_gate_fail integer;
  v_gate_no_data integer;
  v_qualified integer;
  v_qualified_with_indicators integer;
  v_qualified_with_daily_levels integer;
  v_qualified_with_daily_chart integer;
  v_qualified_with_intraday_chart integer;
  v_qualified_with_divergence integer;
  v_critical_errors integer;
  v_missing_storage_objects integer;
  v_errors text[] := '{}';
  v_now timestamptz := now();
begin
  select * into v_manifest from buy_setup_manifests where run_id = p_run_id for update;
  if not found then raise exception 'buy_setup_manifests row for run % does not exist -- enrichment was never started', p_run_id; end if;

  select count(*) into v_expected_equities from run_universe_instruments where run_id = p_run_id and not is_index;

  select count(*) filter (where rule_id = 'BSA-G1') into v_gate_rows from buy_setup_gate_traces where run_id = p_run_id;
  select count(*) filter (where rule_id = 'BSA-G1' and result = 'PASS') into v_gate_pass from buy_setup_gate_traces where run_id = p_run_id;
  select count(*) filter (where rule_id = 'BSA-G1' and result = 'FAIL') into v_gate_fail from buy_setup_gate_traces where run_id = p_run_id;
  select count(*) filter (where rule_id = 'BSA-G1' and result in ('NO_DATA', 'MANUAL_REVIEW')) into v_gate_no_data from buy_setup_gate_traces where run_id = p_run_id;
  v_qualified := v_gate_pass;

  select count(*) into v_qualified_with_indicators
    from buy_setup_intraday_indicators i join buy_setup_gate_traces g
      on g.run_id = i.run_id and g.instrument_id = i.instrument_id and g.rule_id = 'BSA-G1' and g.result = 'PASS'
    where i.run_id = p_run_id;
  select count(*) into v_qualified_with_daily_levels
    from buy_setup_chart_levels l join buy_setup_gate_traces g
      on g.run_id = l.run_id and g.instrument_id = l.instrument_id and g.rule_id = 'BSA-G1' and g.result = 'PASS'
    where l.run_id = p_run_id;
  select count(*) into v_qualified_with_daily_chart
    from buy_setup_charts c join buy_setup_gate_traces g
      on g.run_id = c.run_id and g.instrument_id = c.instrument_id and g.rule_id = 'BSA-G1' and g.result = 'PASS'
    where c.run_id = p_run_id and c.timeframe = 'daily';
  select count(*) into v_qualified_with_intraday_chart
    from buy_setup_charts c join buy_setup_gate_traces g
      on g.run_id = c.run_id and g.instrument_id = c.instrument_id and g.rule_id = 'BSA-G1' and g.result = 'PASS'
    where c.run_id = p_run_id and c.timeframe = '15m';
  select count(distinct instrument_id) into v_qualified_with_divergence
    from buy_setup_divergence_evidence d join buy_setup_gate_traces g
      on g.run_id = d.run_id and g.instrument_id = d.instrument_id and g.rule_id = 'BSA-G1' and g.result = 'PASS'
    where d.run_id = p_run_id
    group by d.run_id having count(distinct indicator) = 2;
  v_qualified_with_divergence := coalesce(v_qualified_with_divergence, 0);

  select count(*) into v_critical_errors from buy_setup_persistence_errors where run_id = p_run_id;

  with referenced_paths as (
    select chart_object_path as object_path from buy_setup_charts where run_id = p_run_id
  )
  select count(*) into v_missing_storage_objects
    from referenced_paths p left join storage.objects o
      on o.bucket_id = 'direction-charts' and o.name = p.object_path
    where o.id is null;

  if v_expected_equities <= 0 then v_errors := array_append(v_errors, 'expected equity universe is empty'); end if;
  if v_gate_rows <> v_expected_equities then
    v_errors := array_append(v_errors, format('BSA-G1 gate trace count (%s) does not match expected equity universe (%s)', v_gate_rows, v_expected_equities));
  end if;
  if v_gate_pass + v_gate_fail + v_gate_no_data <> v_gate_rows then
    v_errors := array_append(v_errors, 'total equities does not equal PASS + FAIL + NO_DATA/MANUAL_REVIEW');
  end if;
  if v_qualified > 0 and v_qualified_with_indicators <> v_qualified then
    v_errors := array_append(v_errors, format('%s of %s gate-qualified instruments are missing 15-minute indicator evidence', v_qualified - v_qualified_with_indicators, v_qualified));
  end if;
  if v_qualified > 0 and v_qualified_with_daily_levels <> v_qualified then
    v_errors := array_append(v_errors, format('%s of %s gate-qualified instruments are missing daily chart-structure evidence', v_qualified - v_qualified_with_daily_levels, v_qualified));
  end if;
  if v_qualified > 0 and v_qualified_with_daily_chart <> v_qualified then
    v_errors := array_append(v_errors, format('%s of %s gate-qualified instruments are missing a daily chart', v_qualified - v_qualified_with_daily_chart, v_qualified));
  end if;
  if v_qualified > 0 and v_qualified_with_intraday_chart <> v_qualified then
    v_errors := array_append(v_errors, format('%s of %s gate-qualified instruments are missing a 15-minute chart', v_qualified - v_qualified_with_intraday_chart, v_qualified));
  end if;
  if v_qualified > 0 and v_qualified_with_divergence <> v_qualified then
    v_errors := array_append(v_errors, format('%s of %s gate-qualified instruments are missing one or both divergence-evidence rows', v_qualified - v_qualified_with_divergence, v_qualified));
  end if;
  if v_critical_errors > 0 then
    v_errors := array_append(v_errors, format('%s unresolved critical persistence error(s) recorded', v_critical_errors));
  end if;
  if v_missing_storage_objects > 0 then
    v_errors := array_append(v_errors, format('%s referenced chart object(s) missing from storage', v_missing_storage_objects));
  end if;
  if v_manifest.rule_version is null or v_manifest.parameter_version is null or v_manifest.parameter_version_id is null then
    v_errors := array_append(v_errors, 'rule_version/parameter_version/parameter_version_id were not pinned on the manifest');
  end if;

  update buy_setup_manifests set
    expected_equity_count = v_expected_equities,
    qualified_count = v_qualified,
    manual_review_count = v_gate_no_data,
    error_count = v_critical_errors,
    validation_errors = to_jsonb(v_errors),
    validated_at = v_now,
    enrichment_state = case when cardinality(v_errors) > 0 then 'validation_failed' else 'published' end,
    published_at = case when cardinality(v_errors) > 0 then null else v_now end
  where run_id = p_run_id;

  if cardinality(v_errors) > 0 then
    return jsonb_build_object('published', false, 'errors', to_jsonb(v_errors));
  end if;
  return jsonb_build_object('published', true, 'errors', '[]'::jsonb);
end;
$function$;

-- ---------------------------------------------------------------------------
-- RLS: SELECT-only to authenticated, gated by this run's OWN enrichment
-- manifest state. Researcher+ can inspect an in-progress or failed
-- enrichment; a plain Viewer only ever sees a 'published' one. No
-- INSERT/UPDATE/DELETE grant to anon/authenticated anywhere below -- writes
-- happen only via the enrichment Edge Function's service/secret key, which
-- bypasses RLS entirely, and via the two SECURITY-DEFINER-free RPCs above
-- (owned by whichever role calls them; only the service role ever calls
-- them in practice, exactly like publish_screening_run).
-- ---------------------------------------------------------------------------

alter table buy_setup_manifests enable row level security;
alter table buy_setup_pipeline_batches enable row level security;
alter table buy_setup_persistence_errors enable row level security;
alter table buy_setup_gate_traces enable row level security;
alter table buy_setup_candlestick_detections enable row level security;
alter table buy_setup_chart_pattern_detections enable row level security;
alter table buy_setup_pattern_detector_coverage enable row level security;
alter table buy_setup_ema_crossover enable row level security;
alter table buy_setup_chart_levels enable row level security;
alter table buy_setup_fifteen_minute_bars enable row level security;
alter table buy_setup_intraday_indicators enable row level security;
alter table buy_setup_fifteen_minute_wave enable row level security;
alter table buy_setup_divergence_evidence enable row level security;
alter table buy_setup_charts enable row level security;

create policy buy_setup_manifests_read on buy_setup_manifests
  for select to authenticated using (
    enrichment_state = 'published' or public.current_role_name() in ('researcher', 'strategy_admin', 'system_admin')
  );

-- Operational-only tables (batches, persistence errors): Researcher+ only,
-- never Viewer, regardless of enrichment_state -- these are pipeline
-- internals, not published research evidence (same treatment
-- pipeline_batches/pipeline_persistence_errors already get in 0008/0010).
create policy buy_setup_pipeline_batches_read on buy_setup_pipeline_batches
  for select to authenticated using (public.current_role_name() in ('researcher', 'strategy_admin', 'system_admin'));
create policy buy_setup_persistence_errors_read on buy_setup_persistence_errors
  for select to authenticated using (public.current_role_name() in ('researcher', 'strategy_admin', 'system_admin'));

create policy buy_setup_gate_traces_read on buy_setup_gate_traces
  for select to authenticated using (
    exists (select 1 from buy_setup_manifests m where m.run_id = buy_setup_gate_traces.run_id
      and (m.enrichment_state = 'published' or public.current_role_name() in ('researcher', 'strategy_admin', 'system_admin')))
  );
create policy buy_setup_candlestick_detections_read on buy_setup_candlestick_detections
  for select to authenticated using (
    exists (select 1 from buy_setup_manifests m where m.run_id = buy_setup_candlestick_detections.run_id
      and (m.enrichment_state = 'published' or public.current_role_name() in ('researcher', 'strategy_admin', 'system_admin')))
  );
create policy buy_setup_chart_pattern_detections_read on buy_setup_chart_pattern_detections
  for select to authenticated using (
    exists (select 1 from buy_setup_manifests m where m.run_id = buy_setup_chart_pattern_detections.run_id
      and (m.enrichment_state = 'published' or public.current_role_name() in ('researcher', 'strategy_admin', 'system_admin')))
  );
create policy buy_setup_pattern_detector_coverage_read on buy_setup_pattern_detector_coverage
  for select to authenticated using (
    exists (select 1 from buy_setup_manifests m where m.run_id = buy_setup_pattern_detector_coverage.run_id
      and (m.enrichment_state = 'published' or public.current_role_name() in ('researcher', 'strategy_admin', 'system_admin')))
  );
create policy buy_setup_ema_crossover_read on buy_setup_ema_crossover
  for select to authenticated using (
    exists (select 1 from buy_setup_manifests m where m.run_id = buy_setup_ema_crossover.run_id
      and (m.enrichment_state = 'published' or public.current_role_name() in ('researcher', 'strategy_admin', 'system_admin')))
  );
create policy buy_setup_chart_levels_read on buy_setup_chart_levels
  for select to authenticated using (
    exists (select 1 from buy_setup_manifests m where m.run_id = buy_setup_chart_levels.run_id
      and (m.enrichment_state = 'published' or public.current_role_name() in ('researcher', 'strategy_admin', 'system_admin')))
  );
create policy buy_setup_fifteen_minute_bars_read on buy_setup_fifteen_minute_bars
  for select to authenticated using (
    exists (select 1 from buy_setup_manifests m where m.run_id = buy_setup_fifteen_minute_bars.run_id
      and (m.enrichment_state = 'published' or public.current_role_name() in ('researcher', 'strategy_admin', 'system_admin')))
  );
create policy buy_setup_intraday_indicators_read on buy_setup_intraday_indicators
  for select to authenticated using (
    exists (select 1 from buy_setup_manifests m where m.run_id = buy_setup_intraday_indicators.run_id
      and (m.enrichment_state = 'published' or public.current_role_name() in ('researcher', 'strategy_admin', 'system_admin')))
  );
create policy buy_setup_fifteen_minute_wave_read on buy_setup_fifteen_minute_wave
  for select to authenticated using (
    exists (select 1 from buy_setup_manifests m where m.run_id = buy_setup_fifteen_minute_wave.run_id
      and (m.enrichment_state = 'published' or public.current_role_name() in ('researcher', 'strategy_admin', 'system_admin')))
  );
create policy buy_setup_divergence_evidence_read on buy_setup_divergence_evidence
  for select to authenticated using (
    exists (select 1 from buy_setup_manifests m where m.run_id = buy_setup_divergence_evidence.run_id
      and (m.enrichment_state = 'published' or public.current_role_name() in ('researcher', 'strategy_admin', 'system_admin')))
  );
create policy buy_setup_charts_read on buy_setup_charts
  for select to authenticated using (
    exists (select 1 from buy_setup_manifests m where m.run_id = buy_setup_charts.run_id
      and (m.enrichment_state = 'published' or public.current_role_name() in ('researcher', 'strategy_admin', 'system_admin')))
  );

revoke all on table
  buy_setup_manifests, buy_setup_pipeline_batches, buy_setup_persistence_errors,
  buy_setup_gate_traces, buy_setup_candlestick_detections, buy_setup_chart_pattern_detections,
  buy_setup_pattern_detector_coverage, buy_setup_ema_crossover, buy_setup_chart_levels,
  buy_setup_fifteen_minute_bars, buy_setup_intraday_indicators, buy_setup_fifteen_minute_wave,
  buy_setup_divergence_evidence, buy_setup_charts
  from anon, authenticated;
grant select on table
  buy_setup_manifests, buy_setup_pipeline_batches, buy_setup_persistence_errors,
  buy_setup_gate_traces, buy_setup_candlestick_detections, buy_setup_chart_pattern_detections,
  buy_setup_pattern_detector_coverage, buy_setup_ema_crossover, buy_setup_chart_levels,
  buy_setup_fifteen_minute_bars, buy_setup_intraday_indicators, buy_setup_fifteen_minute_wave,
  buy_setup_divergence_evidence, buy_setup_charts
  to authenticated;

-- ---------------------------------------------------------------------------
-- Denormalized read view for /buy-setup-analysis's main table -- lets the
-- data-access layer push filtering, sorting, and pagination (.eq/.order/
-- .range) down to Postgres instead of loading the full ~501-row ledger into
-- application memory and filtering/paginating there. `security_invoker`
-- means this view enforces the CALLING user's own RLS on every underlying
-- table (instrument_run_results, rule_traces, buy_setup_gate_traces,
-- buy_setup_divergence_evidence, buy_setup_fifteen_minute_wave,
-- buy_setup_intraday_indicators), not the view owner's -- a Viewer querying
-- this view still only ever sees what those tables' own read policies allow
-- (i.e. buy_setup_* rows only once buy_setup_manifests.enrichment_state =
-- 'published').
--
-- overall_status mirrors app/src/lib/data/buy-setup-status.ts's
-- overallStatusFor() exactly (kept in sync by hand -- there is no code
-- generation between the two) so sorting/filtering by status in SQL agrees
-- with what the page displays.
-- ---------------------------------------------------------------------------

create view buy_setup_analysis_ledger with (security_invoker = true) as
select
  irr.run_id,
  irr.instrument_id,
  i.symbol,
  i.name,
  max(case when rt.rule_id = 'BSP-M1' then rt.result end) as monthly_result,
  max(case when rt.rule_id = 'BSP-M1' then rt.observed_values ->> 'monthly_dow_state' end) as monthly_dow_state,
  bool_or(case when rt.rule_id = 'BSP-M1' then (rt.observed_values ->> 'monthly_range_breakout_up_with_volume')::boolean end) as monthly_breakout_up_with_volume,
  max(case when rt.rule_id = 'BSP-M3' then rt.result end) as weekly_result,
  max(case when rt.rule_id = 'BSP-M3' then rt.observed_values ->> 'weekly_dow_state' end) as weekly_dow_state,
  bool_or(case when rt.rule_id = 'BSP-M3' then (rt.observed_values ->> 'weekly_range_breakout_up_with_volume')::boolean end) as weekly_breakout_up_with_volume,
  max(case when bgt.rule_id = 'BSA-D1' then bgt.result end) as daily_result,
  max(case when bgt.rule_id = 'BSA-D1' then bgt.observed_values ->> 'bsa_daily_dow_state' end) as daily_dow_state,
  bool_or(case when bgt.rule_id = 'BSA-D1' then (bgt.observed_values ->> 'bsa_daily_range_breakout_up_with_volume')::boolean end) as daily_breakout_up_with_volume,
  max(case when bgt.rule_id = 'BSA-G1' then bgt.result end) as gate_result,
  bool_or(bgt.rule_id = 'BSA-G1' and bgt.result = 'PASS') as qualified,
  max(w.structure_type || ' ' || w.current_wave || ' (' || w.confidence || ')') as fifteen_min_wave,
  max(case when d.indicator = 'rsi' then d.result end) as rsi_reversal_result,
  max(case when d.indicator = 'macd_histogram' then d.result end) as macd_reversal_result,
  bool_or(ind.instrument_id is not null) as has_intraday_indicators,
  case
    when max(case when bgt.rule_id = 'BSA-G1' then bgt.result end) = 'NO_DATA' then 'NO_DATA'
    when max(case when bgt.rule_id = 'BSA-G1' then bgt.result end) = 'FAIL' then 'FAIL'
    when max(case when bgt.rule_id = 'BSA-G1' then bgt.result end) is distinct from 'PASS' then 'MANUAL_REVIEW'
    when not bool_or(ind.instrument_id is not null) then 'NO_DATA'
    else 'TECHNICAL_EVIDENCE_PRESENT'
  end as overall_status,
  max(ind.evidence_candle_ts) as evidence_timestamp
from instrument_run_results irr
join instruments i on i.id = irr.instrument_id
left join rule_traces rt on rt.run_id = irr.run_id and rt.instrument_id = irr.instrument_id and rt.rule_id in ('BSP-M1', 'BSP-M3')
left join buy_setup_gate_traces bgt on bgt.run_id = irr.run_id and bgt.instrument_id = irr.instrument_id and bgt.rule_id in ('BSA-D1', 'BSA-G1')
left join buy_setup_fifteen_minute_wave w on w.run_id = irr.run_id and w.instrument_id = irr.instrument_id
left join buy_setup_divergence_evidence d on d.run_id = irr.run_id and d.instrument_id = irr.instrument_id
left join buy_setup_intraday_indicators ind on ind.run_id = irr.run_id and ind.instrument_id = irr.instrument_id
where not irr.is_index
group by irr.run_id, irr.instrument_id, i.symbol, i.name;

grant select on buy_setup_analysis_ledger to authenticated;

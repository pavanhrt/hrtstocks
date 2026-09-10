-- Phase 2 (durable pipeline foundation) schema for the swing-analysis rebuild.
-- See stock-platform/docs/architecture-plan.md section 4 for the design
-- rationale. Entirely additive/non-destructive: no table is dropped, no
-- column is dropped, no row is deleted. Two existing tables get new columns
-- and a widened uniqueness constraint (both backward-compatible with their
-- current rows -- see comments at each ALTER).
--
-- NOT APPLIED to any remote project as part of authoring this file. Per this
-- initiative's own instructions, database changes for this rebuild are
-- drafted locally and applied only after separate explicit approval.

-- ---------------------------------------------------------------------------
-- market_bars_raw / market_bars_adjusted: add interval-awareness (closes
-- problem #23 -- a daily and an hourly bar for the same session currently
-- collide under the old (instrument_id, session_date, provider) constraint).
-- Existing rows all get interval='1d' (everything ingested so far is daily),
-- which is correct and requires no backfill; `ts` is already populated on
-- every existing row (index.js has always set it), so the new constraint is
-- satisfiable immediately.
-- ---------------------------------------------------------------------------

alter table market_bars_raw
  add column interval text not null default '1d' check (interval in ('1d', '1w', '1mo', '1h')),
  add column is_complete boolean not null default true;

alter table market_bars_raw drop constraint market_bars_raw_instrument_id_session_date_provider_key;
alter table market_bars_raw add constraint market_bars_raw_instrument_interval_ts_provider_key
  unique (instrument_id, interval, ts, provider);

alter table market_bars_adjusted
  add column interval text not null default '1d' check (interval in ('1d', '1w', '1mo', '1h')),
  add column is_complete boolean not null default true;

alter table market_bars_adjusted drop constraint market_bars_adjusted_instrument_id_session_date_adjustment__key;
alter table market_bars_adjusted add constraint market_bars_adjusted_instrument_interval_ts_adj_key
  unique (instrument_id, interval, ts, adjustment_version);

-- ---------------------------------------------------------------------------
-- Durable, resumable pipeline: atomic run leasing + batch/cursor state.
-- Replaces the non-atomic "select status='running' then insert" check this
-- session's earlier fix used (problem #11) with a single-row-per-run-type
-- compare-and-swap: acquisition is one UPDATE ... WHERE ... RETURNING,
-- atomic under Postgres' read-committed row locking, and self-healing via
-- expires_at (a lease whose holder was hard-killed is reclaimable once its
-- heartbeat goes stale, with no manual SQL cleanup required).
-- ---------------------------------------------------------------------------

create table screening_run_leases (
  run_type text primary key,
  run_id uuid references screening_runs(id),
  status text not null default 'released' check (status in ('active', 'released')),
  acquired_at timestamptz,
  heartbeat_at timestamptz,
  expires_at timestamptz
);

comment on table screening_run_leases is
  'One row per run_type (e.g. ''eod_screening''). Acquire with: '
  'update screening_run_leases set status=''active'', run_id=$1, acquired_at=now(), '
  'heartbeat_at=now(), expires_at=now() + interval ''10 minutes'' '
  'where run_type=$2 and (status=''released'' or expires_at < now()) returning *; '
  'Zero rows returned means another run currently holds a fresh lease -- do not start. '
  'The holder must periodically bump heartbeat_at/expires_at while it runs, and set '
  'status=''released'' on clean completion.';

insert into screening_run_leases (run_type, status) values ('eod_screening', 'released')
on conflict (run_type) do nothing;

create table pipeline_batches (
  id bigint generated always as identity primary key,
  run_id uuid not null references screening_runs(id) on delete cascade,
  stage text not null check (stage in (
    'universe', 'backfill', 'incremental', 'aggregation', 'direction',
    'alignment', 'hourly_ingest', 'analysis', 'charts', 'reconcile'
  )),
  cursor text,
  attempt integer not null default 0,
  status text not null default 'pending' check (status in ('pending', 'in_progress', 'done', 'failed')),
  last_error text,
  updated_at timestamptz not null default now(),
  unique (run_id, stage, cursor)
);

comment on table pipeline_batches is
  'Resumable unit of work within one pipeline stage of one run. A stage is '
  'done only when every batch row for it is ''done'' -- a time-budget cutoff '
  'leaves remaining batches ''pending'' for the next invocation to pick up '
  '(never converts them into a terminal NO_DATA result -- closes problem #9).';

-- ---------------------------------------------------------------------------
-- Run-scoped Direction evidence (closes problems #6 and #12 for Direction
-- specifically: an aligned classification must come from one run's rows,
-- never a mix of whichever run last touched each timeframe). The existing
-- instrument_direction table (migration 0005) is NOT dropped -- Phase 3
-- repoints its population at this table and turns instrument_direction into
-- a view over "the newest row per instrument+timeframe from one completed
-- run", per architecture-plan.md.
-- ---------------------------------------------------------------------------

create table instrument_direction_runs (
  id bigint generated always as identity primary key,
  run_id uuid not null references screening_runs(id) on delete cascade,
  instrument_id text not null references instruments(id),
  timeframe text not null check (timeframe in ('daily', 'weekly', 'monthly')),
  dow_state text not null check (dow_state in (
    'uptrend_intact', 'downtrend_intact', 'sideways_range',
    'confirmed_reversal_bullish', 'confirmed_reversal_bearish', 'mixed',
    'manual_review', 'unavailable'
  )),
  confirmed_pivots jsonb not null default '[]',
  unconfirmed_leg jsonb,
  trend_defining_level numeric,
  confirmation_trigger numeric,
  invalidation_level numeric,
  chart_object_path text,
  chart_input_hash text,
  chart_algorithm_version text not null,
  chart_renderer_version text not null,
  data_quality data_quality_state not null,
  computed_at timestamptz not null default now(),
  unique (run_id, instrument_id, timeframe)
);

-- ---------------------------------------------------------------------------
-- Confirmed + candidate pivots (separate from the jsonb blob above so a
-- pivot's own confidence/label can be queried and tested directly).
-- ---------------------------------------------------------------------------

create table direction_pivots (
  id bigint generated always as identity primary key,
  run_id uuid not null references screening_runs(id) on delete cascade,
  instrument_id text not null references instruments(id),
  timeframe text not null check (timeframe in ('daily', 'weekly', 'monthly')),
  label text not null check (label in ('HH', 'HL', 'LH', 'LL', 'EH', 'EL', 'H', 'L')),
  price numeric not null,
  bar_date date not null,
  confidence text not null default 'confirmed' check (confidence in ('confirmed', 'candidate')),
  sequence_index integer not null
);
create index direction_pivots_lookup on direction_pivots (run_id, instrument_id, timeframe, sequence_index);

-- ---------------------------------------------------------------------------
-- Elliott wave hypotheses: primary + alternative, with the actual rule
-- arithmetic and an invalidation condition -- never just a label.
-- ---------------------------------------------------------------------------

create table elliott_hypotheses (
  id bigint generated always as identity primary key,
  run_id uuid not null references screening_runs(id) on delete cascade,
  instrument_id text not null references instruments(id),
  timeframe text not null check (timeframe in ('daily', 'weekly', 'monthly')),
  rank text not null check (rank in ('primary', 'alternative')),
  structure_type text not null check (structure_type in (
    'impulse', 'zigzag', 'flat', 'triangle', 'ending_diagonal', 'leading_diagonal', 'combination'
  )),
  current_wave text not null,
  wave_state text not null check (wave_state in ('forming', 'completed')),
  degree text,
  rule_arithmetic jsonb not null default '{}',
  confidence text not null check (confidence in ('confirmed', 'tentative', 'unconfirmed')),
  invalidation_price numeric,
  invalidation_condition text,
  source_locator text,
  computed_at timestamptz not null default now()
);
create index elliott_hypotheses_lookup on elliott_hypotheses (run_id, instrument_id, timeframe, rank);

-- ---------------------------------------------------------------------------
-- Pattern detections: state machine (OBSERVED -> TRIGGERED / FAILED), never
-- presented as live once its target is already reached (closes problem #15
-- of the "Phase 1" pattern requirements -- historical patterns stay
-- HISTORICAL, not re-surfaced as actionable).
-- ---------------------------------------------------------------------------

create table pattern_detections (
  id bigint generated always as identity primary key,
  run_id uuid not null references screening_runs(id) on delete cascade,
  instrument_id text not null references instruments(id),
  timeframe text not null check (timeframe in ('daily', 'weekly', 'monthly', '1h')),
  pattern_name text not null,
  direction text not null check (direction in ('bullish', 'bearish')),
  state text not null check (state in ('OBSERVED', 'TRIGGERED', 'FAILED', 'HISTORICAL', 'MANUAL_REVIEW')),
  anchor_points jsonb not null default '[]',
  neckline_or_boundary jsonb,
  trigger_bar_ts timestamptz,
  target_price numeric,
  invalidation_price numeric,
  volume_evidence jsonb,
  source_locator text not null,
  computed_at timestamptz not null default now()
);
create index pattern_detections_lookup on pattern_detections (run_id, instrument_id, timeframe, state);

-- ---------------------------------------------------------------------------
-- Final Direction alignment: computed and persisted server-side only (closes
-- problem #1). React never derives this -- it reads this column.
-- ---------------------------------------------------------------------------

create table instrument_alignment (
  run_id uuid not null references screening_runs(id) on delete cascade,
  instrument_id text not null references instruments(id),
  final_alignment text not null check (final_alignment in (
    'ALIGNED_BULLISH', 'ALIGNED_BEARISH', 'SIDEWAYS', 'MIXED', 'MANUAL_REVIEW', 'UNAVAILABLE'
  )),
  monthly_direction_id bigint references instrument_direction_runs(id),
  weekly_direction_id bigint references instrument_direction_runs(id),
  daily_direction_id bigint references instrument_direction_runs(id),
  elliott_hypothesis_id bigint references elliott_hypotheses(id),
  triggered_bearish_pattern_id bigint references pattern_detections(id),
  triggered_bullish_pattern_id bigint references pattern_detections(id),
  computed_at timestamptz not null default now(),
  primary key (run_id, instrument_id)
);

-- ---------------------------------------------------------------------------
-- Bullish/bearish Analysis results -- one row per hypothesis, never pooled
-- (closes problem #15: a bearish-side failure can never reject the bullish
-- row, because they are different rows).
-- ---------------------------------------------------------------------------

create table swing_analysis_results (
  id bigint generated always as identity primary key,
  run_id uuid not null references screening_runs(id) on delete cascade,
  instrument_id text not null references instruments(id),
  hypothesis text not null check (hypothesis in ('bullish', 'bearish')),
  selected_route text,
  mandatory_gates jsonb not null default '{}',
  confirmation_groups jsonb not null default '{}',
  confirmation_groups_passed integer not null default 0,
  vetoes jsonb not null default '[]',
  pending_conditions jsonb not null default '[]',
  entry_price numeric,
  structural_stop numeric,
  conservative_target numeric,
  risk numeric,
  reward numeric,
  reward_risk_ratio numeric,
  final_action text not null check (final_action in ('BUY', 'SELL', 'WAIT')),
  strategy_version_id uuid references strategy_versions(id),
  data_quality data_quality_state not null,
  computed_at timestamptz not null default now(),
  unique (run_id, instrument_id, hypothesis)
);

create table swing_analysis_rule_traces (
  id bigint generated always as identity primary key,
  analysis_result_id bigint not null references swing_analysis_results(id) on delete cascade,
  rule_id text not null,
  group_name text,
  result rule_result not null,
  observed_values jsonb,
  thresholds jsonb,
  explanation text,
  source_locator text
);
create index swing_analysis_rule_traces_lookup on swing_analysis_rule_traces (analysis_result_id);

-- ---------------------------------------------------------------------------
-- RLS: same pattern as every run-scoped table in 0002_rls.sql -- Viewer sees
-- only rows whose run is completed; Researcher+ can inspect partial/running
-- runs. Writes only via the Edge Function's service/secret key, which
-- bypasses RLS.
-- ---------------------------------------------------------------------------

alter table screening_run_leases enable row level security;
create policy screening_run_leases_read on screening_run_leases
  for select using (public.current_role_name() in ('researcher', 'strategy_admin', 'system_admin'));

alter table pipeline_batches enable row level security;
create policy pipeline_batches_read on pipeline_batches
  for select using (public.current_role_name() in ('researcher', 'strategy_admin', 'system_admin'));

alter table instrument_direction_runs enable row level security;
create policy instrument_direction_runs_read on instrument_direction_runs
  for select using (
    exists (
      select 1 from screening_runs r
      where r.id = instrument_direction_runs.run_id
        and (r.status = 'completed' or public.current_role_name() in ('researcher', 'strategy_admin', 'system_admin'))
    )
  );

alter table direction_pivots enable row level security;
create policy direction_pivots_read on direction_pivots
  for select using (
    exists (
      select 1 from screening_runs r
      where r.id = direction_pivots.run_id
        and (r.status = 'completed' or public.current_role_name() in ('researcher', 'strategy_admin', 'system_admin'))
    )
  );

alter table elliott_hypotheses enable row level security;
create policy elliott_hypotheses_read on elliott_hypotheses
  for select using (
    exists (
      select 1 from screening_runs r
      where r.id = elliott_hypotheses.run_id
        and (r.status = 'completed' or public.current_role_name() in ('researcher', 'strategy_admin', 'system_admin'))
    )
  );

alter table pattern_detections enable row level security;
create policy pattern_detections_read on pattern_detections
  for select using (
    exists (
      select 1 from screening_runs r
      where r.id = pattern_detections.run_id
        and (r.status = 'completed' or public.current_role_name() in ('researcher', 'strategy_admin', 'system_admin'))
    )
  );

alter table instrument_alignment enable row level security;
create policy instrument_alignment_read on instrument_alignment
  for select using (
    exists (
      select 1 from screening_runs r
      where r.id = instrument_alignment.run_id
        and (r.status = 'completed' or public.current_role_name() in ('researcher', 'strategy_admin', 'system_admin'))
    )
  );

alter table swing_analysis_results enable row level security;
create policy swing_analysis_results_read on swing_analysis_results
  for select using (
    exists (
      select 1 from screening_runs r
      where r.id = swing_analysis_results.run_id
        and (r.status = 'completed' or public.current_role_name() in ('researcher', 'strategy_admin', 'system_admin'))
    )
  );

alter table swing_analysis_rule_traces enable row level security;
create policy swing_analysis_rule_traces_read on swing_analysis_rule_traces
  for select using (
    exists (
      select 1 from swing_analysis_results sar
      join screening_runs r on r.id = sar.run_id
      where sar.id = swing_analysis_rule_traces.analysis_result_id
        and (r.status = 'completed' or public.current_role_name() in ('researcher', 'strategy_admin', 'system_admin'))
    )
  );

-- Single-instrument FOME analysis page ("/fome"). Entirely additive: no
-- table is dropped, no column is dropped, no row is deleted, no previously
-- applied migration is edited (per this repo's own forward-only convention,
-- confirmed live in migrations 0013/0016/0017).
--
-- This is a NEW run lineage, deliberately separate from screening_runs /
-- instrument_run_results / rule_traces / buy_setup_manifests: those tables
-- model batch pipelines gated behind a full-universe screening run
-- (confirmed live: buy_setup_manifests.run_id is a hard FK to
-- screening_runs, and its whole design assumes "the complete universe of an
-- already-published run"). FOME is a user-triggered, single-instrument,
-- on-demand analysis with no dependency on any screening_runs row at all --
-- an instrument that has never been screened by run-screening can still be
-- analyzed here. Reusing buy_setup_manifests' shape would force a fictional
-- screening_runs row into existence for every ad hoc FOME request; a
-- dedicated table set is the honest design.
--
-- NOT applied to the live project as part of authoring this file -- applied
-- only after the explicit staging-deployment confirmation this task
-- requires.

-- ---------------------------------------------------------------------------
-- The run itself: one row per triggered analysis, staged progress for the
-- page's 10-step loading UI, immutable once completed/failed/partial.
-- as_of_timestamp freezes ONE cutoff per run (this repo's own established
-- reproducibility convention -- nse-calendar.js's freezeEodCutoff/
-- as_of_timestamp pattern from migration 0010) so every timeframe/rule/
-- strategy evidence row this run produces is provably drawn from data no
-- newer than one frozen instant, never a moving target while the analysis
-- is in flight.
-- ---------------------------------------------------------------------------

create table fome_analysis_runs (
  id uuid primary key default gen_random_uuid(),
  instrument_id text not null references instruments(id),
  status run_status not null default 'queued',
  as_of_timestamp timestamptz not null,
  current_stage text,
  stage_history jsonb not null default '[]',
  final_alignment text check (final_alignment in (
    'ALIGNED_BULLISH', 'ALIGNED_BEARISH', 'SIDEWAYS', 'VOLATILITY_EXPANSION',
    'MIXED', 'WAIT_FOR_ENTRY_CONFIRMATION', 'MANUAL_REVIEW', 'UNAVAILABLE'
  )),
  alignment_reason text,
  underlying_alignment text, -- set only when final_alignment = WAIT_FOR_ENTRY_CONFIRMATION (the higher-timeframe call the 15m gate deferred, never discarded)
  derivative_eligible boolean,
  derivative_source text, -- e.g. 'fyers' -- broker-sourced, not the official NSE contract master (see fyers-derivatives.js's own header comment); disclosed here so the page can show provenance, not authority
  selected_expiry date,
  selected_expiry_epoch text,
  spot_derivative_aligned boolean,
  spot_derivative_skew_reason text,
  news_relevance text check (news_relevance in (
    'SUPPORTS_TECHNICAL_TREND', 'OPPOSES_TECHNICAL_TREND', 'MIXED_NEWS', 'NO_MATERIAL_NEWS', 'NEWS_UNAVAILABLE'
  )),
  algorithm_version text,
  rule_version text,
  parameter_version text,
  strategy_engine_version text,
  chart_render_version text,
  providers jsonb not null default '{}',
  data_quality data_quality_state,
  error_message text,
  triggered_by uuid references auth.users(id),
  started_at timestamptz,
  completed_at timestamptz,
  created_at timestamptz not null default now()
);

comment on table fome_analysis_runs is
  'One row per user-triggered single-instrument FOME analysis. current_stage/'
  'stage_history back the /fome page''s 10-step progress UI. as_of_timestamp '
  'is the one frozen cutoff every bar/quote/rule in this run must respect. '
  'Immutable once status is completed, failed, or partial -- a fresh '
  '"Analyze latest data" click always creates a new row, never overwrites '
  'a prior result.';

create index fome_analysis_runs_instrument_idx on fome_analysis_runs (instrument_id, created_at desc);

-- ---------------------------------------------------------------------------
-- Per-timeframe Direction-table rows (Monthly/Weekly/Daily/15-minute).
-- ---------------------------------------------------------------------------

create table fome_timeframe_results (
  id bigint generated always as identity primary key,
  analysis_run_id uuid not null references fome_analysis_runs(id) on delete cascade,
  timeframe text not null check (timeframe in ('monthly', 'weekly', 'daily', '15m')),
  latest_completed_candle_at timestamptz,
  freshness freshness_label,
  is_provisional boolean not null default false,
  dow_state text,
  pivot_sequence text[],
  macd_state text,
  rsi numeric,
  adx numeric,
  adx_slope text,
  bollinger_state text,
  bollinger_price_location text,
  support numeric,
  resistance numeric,
  breakout_state text,
  direction text check (direction in ('bullish', 'bearish', 'sideways')),
  confidence text not null,
  explanation text,
  input_hash text,
  -- Set when this row's value was REUSED from an earlier run rather than
  -- recomputed this run (freshness/cache-policy disclosure) -- null means
  -- this run computed it fresh.
  reused_from_run_id uuid references fome_analysis_runs(id),
  chart_object_path text,
  chart_content_hash text check (chart_content_hash is null or chart_content_hash ~ '^[a-f0-9]{64}$'),
  chart_alt_text text,
  computed_at timestamptz not null default now(),
  unique (analysis_run_id, timeframe)
);

-- ---------------------------------------------------------------------------
-- 15-minute bar evidence -- persisted for reproducibility, mirroring this
-- repo's own buy_setup_fifteen_minute_bars convention (migration 0011), a
-- SEPARATE table rather than widening market_bars_raw's own interval CHECK:
-- market_bars_raw is this project's canonical DAILY store, populated
-- exclusively by run-screening for the full universe; every other
-- 15-minute/intraday feature in this codebase (buy-setup) already keeps its
-- own intraday bars in its own table rather than writing into
-- market_bars_raw, and FOME follows the same established pattern rather
-- than introducing a second convention for the same kind of data. The
-- CLOSE-CONFIRMED bars this run actually reasoned about are the immutable
-- record; a still-forming candle is deliberately NEVER inserted here (only
-- ever shown live, from the run's own transient in-memory fetch) so this
-- table can never be mistaken for having treated an incomplete candle as
-- evidence.
-- ---------------------------------------------------------------------------

create table fome_fifteen_minute_bars (
  analysis_run_id uuid not null references fome_analysis_runs(id) on delete cascade,
  instrument_id text not null references instruments(id),
  session_date date not null,
  ts timestamptz not null,
  open numeric check (open > 0),
  high numeric check (high > 0),
  low numeric check (low > 0),
  close numeric check (close > 0),
  volume numeric check (volume >= 0),
  provider text not null,
  is_complete boolean not null default true,
  created_at timestamptz not null default now(),
  primary key (analysis_run_id, ts)
);

create index fome_fifteen_minute_bars_instrument_idx on fome_fifteen_minute_bars (instrument_id, ts);

-- ---------------------------------------------------------------------------
-- Per-rule trace -- same shape as rule_traces (0001), but its own table
-- since fome_analysis_runs is a different run lineage than screening_runs.
-- ---------------------------------------------------------------------------

create table fome_rule_traces (
  id bigint generated always as identity primary key,
  analysis_run_id uuid not null references fome_analysis_runs(id) on delete cascade,
  rule_id text not null,
  rule_version text,
  parameter_version text,
  timeframe text,
  observed_values jsonb,
  thresholds jsonb,
  result rule_result not null,
  source_status rule_source_status,
  data_source text,
  source_document text,
  source_locator text,
  explanation text,
  evaluation_timestamp timestamptz not null default now()
);

create index fome_rule_traces_run_idx on fome_rule_traces (analysis_run_id);

-- ---------------------------------------------------------------------------
-- Strategy comparison rows (fome/strategy-comparison.js's compareStrategies()
-- output, persisted immutably alongside the run that produced it).
-- ---------------------------------------------------------------------------

create table fome_strategy_candidates (
  id bigint generated always as identity primary key,
  analysis_run_id uuid not null references fome_analysis_runs(id) on delete cascade,
  rank integer not null,
  strategy_id text not null,
  qualification_status text not null check (qualification_status in ('qualified', 'watch', 'not_qualified', 'manual_review', 'no_data')),
  why_fits text,
  why_fails text,
  legs jsonb not null default '[]',
  lot_size numeric, -- null when unresolved -- never a guessed default (see fome/contract-selection.js)
  net_debit_or_credit numeric,
  break_evens numeric[],
  max_profit numeric,
  max_loss numeric,
  margin_state text not null default 'unavailable' check (margin_state in ('available', 'unavailable')),
  margin numeric,
  reward_risk numeric,
  liquidity_state text,
  time_decay_exposure text,
  iv_exposure text,
  expiry_suitability text,
  position_size jsonb,
  roi_pct numeric,
  unlimited_risk boolean not null default false,
  final_classification text,
  data_quality data_quality_state,
  unique (analysis_run_id, strategy_id)
);

create index fome_strategy_candidates_run_idx on fome_strategy_candidates (analysis_run_id, rank);

-- ---------------------------------------------------------------------------
-- News snapshot -- frozen at analysis time (immutable-result requirement),
-- not re-fetched live on every subsequent page view of the same run.
-- ---------------------------------------------------------------------------

create table fome_news_items (
  id bigint generated always as identity primary key,
  analysis_run_id uuid not null references fome_analysis_runs(id) on delete cascade,
  headline text not null,
  source text,
  published_at timestamptz,
  url text,
  event_category text,
  relevance text check (relevance in ('supportive', 'opposing', 'neutral', 'uncertain')),
  confidence text check (confidence in ('low', 'medium', 'high')),
  explanation text,
  created_at timestamptz not null default now()
);

create index fome_news_items_run_idx on fome_news_items (analysis_run_id);

-- ---------------------------------------------------------------------------
-- RLS: consistent with instrument_direction's "any signed-in user may read"
-- pattern (0005) -- a FOME analysis is a shared research artifact triggered
-- by any authenticated user, not private per-user data, matching how
-- non-run-scoped computed tables already work in this app. Writes only via
-- the fome-analysis Edge Function's service/secret key (APP_SECRET_KEYS),
-- which bypasses RLS -- no INSERT/UPDATE/DELETE grant to anon/authenticated
-- on any table below, matching this repo's own buy_setup_*/fundamental_*
-- convention (migrations 0011/0014).
-- ---------------------------------------------------------------------------

alter table fome_analysis_runs enable row level security;
create policy fome_analysis_runs_read on fome_analysis_runs
  for select using (auth.role() = 'authenticated');

alter table fome_timeframe_results enable row level security;
create policy fome_timeframe_results_read on fome_timeframe_results
  for select using (auth.role() = 'authenticated');

alter table fome_fifteen_minute_bars enable row level security;
create policy fome_fifteen_minute_bars_read on fome_fifteen_minute_bars
  for select using (auth.role() = 'authenticated');

alter table fome_rule_traces enable row level security;
create policy fome_rule_traces_read on fome_rule_traces
  for select using (auth.role() = 'authenticated');

alter table fome_strategy_candidates enable row level security;
create policy fome_strategy_candidates_read on fome_strategy_candidates
  for select using (auth.role() = 'authenticated');

alter table fome_news_items enable row level security;
create policy fome_news_items_read on fome_news_items
  for select using (auth.role() = 'authenticated');

revoke all on fome_analysis_runs, fome_timeframe_results, fome_fifteen_minute_bars, fome_rule_traces, fome_strategy_candidates, fome_news_items
  from anon, authenticated;
grant select on fome_analysis_runs, fome_timeframe_results, fome_fifteen_minute_bars, fome_rule_traces, fome_strategy_candidates, fome_news_items
  to authenticated;

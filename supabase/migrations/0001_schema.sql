-- Phase 1 schema for the stock research platform.
-- See references/technical-architecture.md and references/rule-schema.md for the
-- entity/field rationale; this migration is the executable counterpart of those docs.

create extension if not exists pgcrypto;

create type user_role as enum ('viewer','researcher','strategy_admin','system_admin');
create type terminal_state as enum ('PASS','WATCH','MANUAL_REVIEW','FAIL','NO_DATA');
create type rule_result as enum ('PASS','FAIL','WATCH','MANUAL_REVIEW','NO_DATA','NOT_APPLICABLE','CONFLICT');
create type rule_source_status as enum ('DOCUMENTED','PROJECT_DEFAULT','INFERRED','CONFLICT','UNRESOLVED');
create type data_quality_state as enum ('PASS','PARTIAL','STALE','INVALID','NO_DATA');
create type freshness_label as enum ('LIVE','DELAYED','INTRADAY','EOD');
create type run_tier as enum ('tier_a','tier_b','watch','manual_review','rejected','unavailable');
create type run_status as enum ('queued','running','completed','failed','partial');
create type run_trigger_type as enum ('manual','scheduled');

-- ---------------------------------------------------------------------------
-- Auth / roles
-- ---------------------------------------------------------------------------

create table profiles (
  id uuid primary key references auth.users(id) on delete cascade,
  email text not null,
  role user_role not null default 'viewer',
  display_name text,
  created_at timestamptz not null default now()
);

comment on table profiles is 'One row per auth.users, carries the app-level role used by RLS and page guards.';

-- Emails listed here are promoted to system_admin on first signup instead of the
-- default viewer role. Seeded once by the operator, not exposed in any UI.
create table bootstrap_admin_emails (
  email text primary key
);

create function public.handle_new_user()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  insert into public.profiles (id, email, role)
  values (
    new.id,
    new.email,
    case when exists (
      select 1 from public.bootstrap_admin_emails b where lower(b.email) = lower(new.email)
    ) then 'system_admin'::user_role else 'viewer'::user_role end
  );
  return new;
end;
$$;

create trigger on_auth_user_created
  after insert on auth.users
  for each row execute function public.handle_new_user();

-- ---------------------------------------------------------------------------
-- Strategy / rule / parameter registry (populated by supabase/seed/seed-strategies.ts
-- from strategies/*.yaml and config/parameters.yaml -- YAML remains the authored
-- source of truth, these tables are the versioned executable snapshot).
-- ---------------------------------------------------------------------------

create table strategy_versions (
  id uuid primary key default gen_random_uuid(),
  framework text not null,
  strategy_id text not null,
  rule_version text not null,
  parameter_version text,
  status text not null,
  is_active boolean not null default true,
  raw_yaml jsonb not null,
  created_at timestamptz not null default now(),
  unique (strategy_id, rule_version)
);

create table rule_definitions (
  id uuid primary key default gen_random_uuid(),
  strategy_version_id uuid not null references strategy_versions(id) on delete cascade,
  rule_id text not null,
  framework text not null,
  name text not null,
  source_status rule_source_status not null,
  scope text,
  timeframe text,
  direction text,
  inputs text[] not null default '{}',
  expression text not null,
  true_result rule_result not null,
  false_result rule_result not null,
  missing_result rule_result not null,
  hard_gate boolean not null default false,
  parameters text[] not null default '{}',
  source_refs jsonb,
  raw jsonb not null,
  created_at timestamptz not null default now(),
  unique (strategy_version_id, rule_id)
);

create table parameter_versions (
  id uuid primary key default gen_random_uuid(),
  version text not null unique,
  status text not null,
  values jsonb not null,
  created_at timestamptz not null default now()
);

-- ---------------------------------------------------------------------------
-- Universe
-- ---------------------------------------------------------------------------

create table instruments (
  id text primary key,
  symbol text not null,
  name text,
  exchange text not null default 'NSE',
  isin text,
  is_index boolean not null default false,
  created_at timestamptz not null default now()
);

create table index_memberships (
  id uuid primary key default gen_random_uuid(),
  index_id text not null references instruments(id),
  instrument_id text not null references instruments(id),
  effective_date date not null,
  is_current boolean not null default true,
  created_at timestamptz not null default now(),
  unique (index_id, instrument_id, effective_date)
);

-- ---------------------------------------------------------------------------
-- Market data
-- ---------------------------------------------------------------------------

create table market_bars_raw (
  id bigint generated always as identity primary key,
  instrument_id text not null references instruments(id),
  session_date date not null,
  ts timestamptz not null,
  open numeric,
  high numeric,
  low numeric,
  close numeric,
  volume numeric,
  provider text not null,
  freshness freshness_label not null,
  retrieved_at timestamptz not null default now(),
  unique (instrument_id, session_date, provider)
);

create table market_bars_adjusted (
  id bigint generated always as identity primary key,
  instrument_id text not null references instruments(id),
  session_date date not null,
  ts timestamptz not null,
  open numeric,
  high numeric,
  low numeric,
  close numeric,
  volume numeric,
  adjustment_version text not null default '1.0.0',
  created_at timestamptz not null default now(),
  unique (instrument_id, session_date, adjustment_version)
);

create table corporate_actions (
  id uuid primary key default gen_random_uuid(),
  instrument_id text not null references instruments(id),
  action_type text not null,
  ex_date date not null,
  factor numeric,
  raw jsonb,
  created_at timestamptz not null default now()
);

create table data_quality_results (
  id bigint generated always as identity primary key,
  run_id uuid,
  instrument_id text references instruments(id),
  check_name text not null,
  result data_quality_state not null,
  details jsonb,
  created_at timestamptz not null default now()
);

-- Derivative tables exist for schema stability but stay unpopulated in Phase 1;
-- FOME rules render as NOT_APPLICABLE until Phase 3 contract-master ingestion lands.
create table derivative_contracts (
  id uuid primary key default gen_random_uuid(),
  instrument_id text references instruments(id),
  contract_type text not null,
  expiry date,
  strike numeric,
  lot_size numeric,
  raw jsonb,
  created_at timestamptz not null default now()
);

create table derivative_snapshots (
  id bigint generated always as identity primary key,
  contract_id uuid references derivative_contracts(id),
  ts timestamptz not null,
  last numeric,
  bid numeric,
  ask numeric,
  volume numeric,
  oi numeric,
  oi_change numeric,
  iv numeric,
  raw jsonb
);

-- ---------------------------------------------------------------------------
-- Runs / results (written only by the run-screening Edge Function via the
-- service role key, which bypasses RLS -- see 0002_rls.sql).
-- ---------------------------------------------------------------------------

create table screening_runs (
  id uuid primary key default gen_random_uuid(),
  run_date date not null,
  mode text not null default 'EOD',
  status run_status not null default 'queued',
  universe_version text not null,
  parameter_version_id uuid references parameter_versions(id),
  strategy_version_ids uuid[] not null default '{}',
  providers jsonb,
  trigger_type run_trigger_type not null,
  triggered_by uuid references auth.users(id),
  started_at timestamptz,
  completed_at timestamptz,
  created_at timestamptz not null default now()
);

create table instrument_run_results (
  id bigint generated always as identity primary key,
  run_id uuid not null references screening_runs(id) on delete cascade,
  instrument_id text not null references instruments(id),
  is_index boolean not null default false,
  direction text,
  terminal_state terminal_state not null,
  tier run_tier,
  score numeric,
  failed_gates text[] not null default '{}',
  data_quality data_quality_state,
  created_at timestamptz not null default now(),
  unique (run_id, instrument_id)
);

create table rule_traces (
  id bigint generated always as identity primary key,
  run_id uuid not null references screening_runs(id) on delete cascade,
  instrument_id text not null references instruments(id),
  rule_id text not null,
  rule_version text,
  parameter_version text,
  observed_values jsonb,
  thresholds jsonb,
  result rule_result not null,
  confidence numeric,
  data_source text,
  source_document text,
  source_locator text,
  explanation text,
  evaluation_timestamp timestamptz not null default now()
);

create table rankings (
  id bigint generated always as identity primary key,
  run_id uuid not null references screening_runs(id) on delete cascade,
  instrument_id text not null references instruments(id),
  direction text,
  tier run_tier not null,
  total_score numeric,
  component_scores jsonb,
  rank_within_tier integer
);

create table coverage_reconciliation (
  run_id uuid primary key references screening_runs(id) on delete cascade,
  unique_stock_count integer not null,
  tier_a integer not null,
  tier_b integer not null,
  watch integer not null,
  manual_review integer not null,
  rejected integer not null,
  unavailable integer not null,
  reconciled boolean not null
);

create table pipeline_audit_log (
  id bigint generated always as identity primary key,
  run_id uuid references screening_runs(id) on delete cascade,
  stage text not null,
  status text not null,
  message text,
  created_at timestamptz not null default now()
);

create index on index_memberships (instrument_id);
create index on market_bars_raw (instrument_id, session_date);
create index on market_bars_adjusted (instrument_id, session_date);
create index on instrument_run_results (run_id);
create index on rule_traces (run_id, instrument_id);
create index on rankings (run_id, tier);
create index on screening_runs (run_date desc);

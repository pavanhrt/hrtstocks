-- Originally authored for Supabase; made self-contained for plain PostgreSQL / Cloud SQL (see docs/gcp/schema-provenance.md).
-- Supabase-only statements (RLS, policies, role grants, auth/storage/cron) were removed or replaced.

-- Fundamental Analysis Score (fundamentals/fundamental-score.yaml) --
-- PROJECT_DEFAULT, user-requested fundamental-quality overlay. Completely
-- independent of every technical framework (SMM/PAPA/GUE/FOME/BSP/SSP/
-- WBP/WSP/BSA): no table here is read by screening-rules.js's
-- classification, three-timeframe-gate.js, or publish_buy_setup_enrichment.
-- It is joined into buy_setup_analysis_ledger purely for DISPLAY, additively
-- (every existing column is untouched), and never feeds back into any
-- technical gate, qualification count, or overall_status.
--
-- NOT YET APPLIED to any database as of authoring -- see CONTINUATION.md's
-- "Fundamental score" section for the exact provider decision this is
-- blocked on before any real row can be written. This migration is written,
-- reviewed, and syntax-checked, but deliberately not run until explicit
-- deployment approval (matching this task's own operating rules). Revised
-- 2026-09-16 (still never applied anywhere -- safe to revise in place
-- rather than layering a 0015 patch) to fix five issues found on review:
-- see the "REVISED 2026-09-16" notes scattered through this file at each
-- fix site, and CONTINUATION.md's "Fundamental score corrections" section
-- for the full writeup.
--
-- REVISED 2026-09-16 (second pass, correction review) -- still never applied
-- anywhere, still safe to revise in place:
--   * audit_status is now NULLABLE, never a fabricated 'unaudited' when a
--     provider simply does not disclose the field (mirrors normalize.js's
--     REQUIRED_BUT_NULLABLE_FIELDS treatment).
--   * publication_timestamp_is_estimated is REMOVED. Replaced with the
--     honest four-field timestamp-basis model also used by normalize.js /
--     filings.js: publication_timestamp (nullable -- the provider's actual
--     disclosed filing/publication time, when one exists), available_from
--     (never null -- the latest DEFENSIBLE lower bound a cutoff may rely on),
--     and timestamp_basis (PROVIDER_PUBLICATION | EXCHANGE_FILING |
--     RETRIEVAL_ONLY) recording which of those two available_from actually
--     is. A CHECK constraint enforces the same consistency normalize.js
--     enforces in application code: RETRIEVAL_ONLY <=> publication_timestamp
--     is null and available_from = retrieved_at; the other two bases <=>
--     publication_timestamp is not null and available_from =
--     publication_timestamp. Every filing-selection/cutoff comparison in
--     this file now uses available_from, never publication_timestamp
--     directly, since publication_timestamp can be null.
--   * bind_fundamental_scores_for_refresh() now verifies
--     p_refresh_manifest_id itself is published before doing anything, and
--     its own best-match CTE now joins fundamental_refresh_manifests and
--     requires refresh_state = 'published' on every CANDIDATE result too --
--     previously a processing/validation_failed/orphaned row for an
--     instrument could theoretically win the "latest cutoff" ordering
--     ahead of an older but actually-published row. EXECUTE on both bind
--     functions is now revoked from PUBLIC/anon/authenticated and granted
--     only to service_role -- these are operational RPCs, never callable
--     from a browser session.
--   * New bind_fundamental_scores_for_run(p_run_id uuid): the mirror-image
--     entry point for correction 6 -- a fundamental refresh may already be
--     published before a screening run publishes (the common case today),
--     but a screening run could also publish first with fundamentals
--     catching up later; both directions must eventually converge on the
--     same binding. This function runs the identical selection logic keyed
--     from the run side instead of the refresh side, and is exposed so a
--     (not-yet-built) screening-run publish step can call it exactly once
--     per newly published run, the same way the fundamental publish step
--     calls bind_fundamental_scores_for_refresh.
--   * fundamental_refresh_manifests.refresh_state gains 'auth_required' --
--     a manifest whose ingestion paused mid-refresh because the daily
--     Upstox token expired is a distinct, actionable state, never silently
--     retried and never conflated with 'validation_failed' (a data problem)
--     or left stuck in 'processing' (which looks like normal progress).
--
-- Point-in-time correctness: fundamental_score_results is insert-only per
-- (instrument_id, score_version_id, cutoff_at) -- a new filing NEVER updates
-- an existing row; it can only ever produce a NEW row at a LATER cutoff.
-- filings.js's selectApplicableFiling() (the only code that ever decides
-- which snapshot is "applicable" for a given cutoff) enforces the same rule
-- one layer up, purely in application code, before a row is ever written
-- here.
--
-- REVISED 2026-09-16 -- historical score PINNING: the original version of
-- this migration had buy_setup_analysis_ledger choose a fundamental result
-- with a dynamic `order by r.cutoff_at desc limit 1` at READ time. That is
-- insufficient once more than one score_version exists: a later version's
-- results could start outranking an already-displayed run's original choice
-- on a subsequent read, silently changing what an already-published run
-- shows. Fixed with a new insert-only, trigger-enforced-immutable binding
-- table (buy_setup_fundamental_score_bindings) and a
-- bind_fundamental_scores_for_refresh() RPC that resolves the binding ONCE,
-- mirroring services/pipeline/src/fundamentals/binding.js's own
-- resolveFundamentalBinding() (tested directly, see binding.test.js) --
-- the SQL function below is a direct, mechanical translation of that tested
-- pure function, not an independent reimplementation.

-- ---------------------------------------------------------------------------
-- Immutable raw filing snapshots. One row per (instrument, financial period,
-- consolidation type, source). Never updated after insert -- a corrected
-- filing is a NEW row with its own publication_timestamp and a
-- supersedes_id pointing at the row it revises, never an UPDATE to the
-- original (so an already-selected historical filing can never change under
-- an existing published score_result).
-- ---------------------------------------------------------------------------

create table fundamental_source_snapshots (
  id bigint generated always as identity primary key,
  instrument_id text not null references instruments(id),
  exchange_symbol text not null,
  source text not null,
  source_locator text not null, -- URL or a stable filing identifier
  period_end date not null,
  period_type text not null check (period_type in ('annual', 'quarterly', 'ttm')),
  consolidation text not null check (consolidation in ('consolidated', 'standalone')),
  -- REVISED 2026-09-16: nullable -- undisclosed audit status (confirmed the
  -- case for every Upstox Fundamentals endpoint inspected) is stored as
  -- null, never coerced into 'unaudited' or any other disclosed value. Null
  -- here means "the provider did not say," a distinct and honestly
  -- queryable state from an explicit disclosure of any of the three values.
  audit_status text check (audit_status is null or audit_status in ('audited', 'limited_review', 'unaudited')),
  -- REVISED 2026-09-16 -- timestamp-basis redesign (correction 3). Nullable:
  -- set only when the provider actually discloses a real publication/filing
  -- timestamp. Confirmed null for every Upstox Fundamentals endpoint
  -- inspected 2026-09-16 (see CONTINUATION.md) -- each returns only a
  -- financial-period label like "Mar 2025", never a filing date. When null,
  -- available_from/timestamp_basis below carry the honest, defensible
  -- substitute instead of silently blurring "published" into "retrieved."
  publication_timestamp timestamptz,
  -- The latest DEFENSIBLE lower bound a screening cutoff may rely on to
  -- treat this snapshot as available: publication_timestamp when disclosed,
  -- otherwise retrieved_at (we know it existed by the moment we retrieved
  -- it; we never guess how much earlier). Every filing-selection/cutoff
  -- comparison in this codebase reads THIS column, never
  -- publication_timestamp directly, since that one may be null. Never null.
  available_from timestamptz not null,
  -- Which of the two available_from actually is -- see the consistency
  -- CHECK constraint below, which is the DB-level mirror of
  -- normalize.js's own basis-consistency validation.
  timestamp_basis text not null check (timestamp_basis in ('PROVIDER_PUBLICATION', 'EXCHANGE_FILING', 'RETRIEVAL_ONLY')),
  retrieved_at timestamptz not null check (publication_timestamp is null or retrieved_at >= publication_timestamp),
  currency text not null,
  sector_model text check (sector_model in ('NON_FINANCIAL', 'BANK', 'NBFC') or sector_model is null), -- provider-supplied; null/unrecognized resolves to UNSUPPORTED_FALLBACK at read time, never guessed here
  ownership_structure text check (ownership_structure in ('promoter', 'professionally_managed') or ownership_structure is null),
  raw_values jsonb not null, -- as-reported figures, verbatim
  derived_values jsonb not null default '{}', -- normalized figures computed from raw_values (metrics.js inputs), for traceability
  is_exceptional_item boolean, -- null = undisclosed, never assumed false
  exceptional_item_amount numeric,
  supersedes_id bigint references fundamental_source_snapshots(id),
  checksum text not null,
  validation_status text not null default 'PENDING' check (validation_status in ('PENDING', 'VALID', 'INVALID')),
  validation_errors jsonb not null default '[]',
  created_at timestamptz not null default now(),
  constraint fundamental_source_snapshots_period_check check (available_from >= period_end),
  -- REVISED 2026-09-16: the basis and its two dependent timestamps can
  -- never contradict each other -- mirrors normalize.js's own
  -- RETRIEVAL_ONLY / disclosed-basis consistency checks at the DB layer.
  constraint fundamental_source_snapshots_basis_consistency check (
    (timestamp_basis = 'RETRIEVAL_ONLY' and publication_timestamp is null and available_from = retrieved_at)
    or (timestamp_basis in ('PROVIDER_PUBLICATION', 'EXCHANGE_FILING') and publication_timestamp is not null and available_from = publication_timestamp)
  ),
  -- REVISED 2026-09-16: keyed on available_from (never null) instead of
  -- publication_timestamp (nullable -- and Postgres treats multiple NULLs
  -- in a unique constraint as distinct, which would have silently allowed
  -- duplicate RETRIEVAL_ONLY snapshots for the same period through).
  unique (instrument_id, period_end, period_type, consolidation, source, available_from)
);
create index fundamental_source_snapshots_lookup on fundamental_source_snapshots (instrument_id, period_end desc, available_from desc);

-- ---------------------------------------------------------------------------
-- Fundamental score spec versions -- mirrors parameter_versions/
-- strategy_versions' own role: the parsed fundamental-score.yaml, versioned,
-- immutable once referenced by a published score_result.
-- ---------------------------------------------------------------------------

create table fundamental_score_versions (
  id bigint generated always as identity primary key,
  version text not null unique,
  status text not null,
  spec jsonb not null,
  created_at timestamptz not null default now()
);

-- ---------------------------------------------------------------------------
-- Optional refresh/publication manifest -- mirrors buy_setup_manifests'
-- role: gates whether a batch of score_results is visible to a plain
-- Viewer. A fundamental refresh is its own idempotent workflow (normally
-- triggered when new filings arrive), never coupled to a 15-minute
-- buy-setup run or a daily screening run.
-- ---------------------------------------------------------------------------

create table fundamental_refresh_manifests (
  id bigint generated always as identity primary key,
  score_version_id bigint not null references fundamental_score_versions(id),
  cutoff_at timestamptz not null,
  -- REVISED 2026-09-16 -- 'auth_required' added (correction 7): a refresh
  -- whose ingestion paused mid-run because the daily Upstox token expired
  -- is a distinct, actionable state, never silently retried and never
  -- conflated with 'validation_failed' (a data problem) or left looking
  -- like ordinary in-progress 'processing'.
  refresh_state text not null check (refresh_state in ('pending', 'processing', 'validated', 'validation_failed', 'published', 'auth_required')),
  expected_instrument_count integer not null default 0,
  scored_count integer not null default 0,
  no_data_count integer not null default 0,
  manual_review_count integer not null default 0,
  validation_errors jsonb not null default '[]',
  triggered_by uuid references profiles(id),
  computed_at timestamptz not null default now(),
  validated_at timestamptz,
  published_at timestamptz,
  unique (score_version_id, cutoff_at)
);

-- ---------------------------------------------------------------------------
-- Per-instrument terminal score result. Insert-only per
-- (instrument_id, score_version_id, cutoff_at) -- see header note on
-- immutability. total_score/grade are null whenever terminal_status is not
-- 'SCORED' (never a fabricated 0).
-- ---------------------------------------------------------------------------

create table fundamental_score_results (
  id bigint generated always as identity primary key,
  instrument_id text not null references instruments(id),
  refresh_manifest_id bigint references fundamental_refresh_manifests(id),
  score_version_id bigint not null references fundamental_score_versions(id),
  -- REVISED 2026-09-16 -- Viewer score-version access: fundamental_score_versions
  -- is Researcher+-only (it carries the full operational YAML spec), but a
  -- published result must still be able to show its own version STRING
  -- (e.g. "1.0.0") to a plain Viewer without a second, permission-denied
  -- query. Denormalized here, set once at insert time from the referenced
  -- score_versions row, immutable thereafter (see the trigger below) --
  -- avoids exposing the full spec while still answering "what version
  -- produced this score" for anyone allowed to see the result itself.
  score_version text not null,
  sector_model text not null check (sector_model in ('NON_FINANCIAL', 'BANK', 'NBFC', 'UNSUPPORTED_FALLBACK')),
  cutoff_at timestamptz not null,
  total_score integer check (total_score is null or (total_score >= 0 and total_score <= 100)),
  grade text check (grade in ('A', 'B', 'C', 'D', 'E') or grade is null),
  coverage_percentage numeric not null check (coverage_percentage >= 0 and coverage_percentage <= 100),
  terminal_status text not null check (terminal_status in ('SCORED', 'NO_DATA', 'MANUAL_REVIEW', 'NOT_APPLICABLE')),
  source_snapshot_ids bigint[] not null default '{}',
  computed_at timestamptz not null default now(),
  constraint fundamental_score_results_terminal_consistency check (
    (terminal_status = 'SCORED' and total_score is not null and grade is not null)
    or (terminal_status <> 'SCORED' and total_score is null and grade is null)
  ),
  unique (instrument_id, score_version_id, cutoff_at)
);
create index fundamental_score_results_lookup on fundamental_score_results (instrument_id, cutoff_at desc);
create index fundamental_score_results_manifest on fundamental_score_results (refresh_manifest_id);

-- ---------------------------------------------------------------------------
-- Per-component score evidence -- one row per (score_result, component).
-- sub_metrics carries the full per-sub-metric evidence array (key, weight,
-- applicable, earned, status, value, raw, explanation) exactly as returned
-- by scoring.js's computeComponentScore -- the detail page's evidence table
-- reads this directly, no re-derivation.
-- ---------------------------------------------------------------------------

create table fundamental_score_components (
  id bigint generated always as identity primary key,
  score_result_id bigint not null references fundamental_score_results(id) on delete cascade,
  component_key text not null check (component_key in ('balance_sheet', 'profitability', 'growth', 'promoter_governance', 'cash_flow', 'future_growth')),
  component_name text not null,
  weight integer not null,
  total_applicable_weight numeric not null,
  earned numeric not null,
  status text not null check (status in ('OK', 'NOT_APPLICABLE', 'NO_DATA', 'MANUAL_REVIEW')),
  sub_metrics jsonb not null default '[]',
  unique (score_result_id, component_key)
);

-- ---------------------------------------------------------------------------
-- REVISED 2026-09-16 -- historical score pinning (correction 1). One row per
-- (run_id, instrument_id), pointing at the EXACT fundamental_score_results
-- row that run displays -- resolved once (see
-- bind_fundamental_scores_for_refresh below) and never changed again. A
-- missing binding means NO_DATA for that run/instrument, not an error.
-- ---------------------------------------------------------------------------

create table buy_setup_fundamental_score_bindings (
  run_id uuid not null references screening_runs(id) on delete cascade,
  instrument_id text not null references instruments(id),
  fundamental_score_result_id bigint not null references fundamental_score_results(id),
  bound_at timestamptz not null default now(),
  primary key (run_id, instrument_id)
);
create index buy_setup_fundamental_score_bindings_result on buy_setup_fundamental_score_bindings (fundamental_score_result_id);

-- ---------------------------------------------------------------------------
-- REVISED 2026-09-16 -- real append-only enforcement (correction 2). A
-- unique constraint alone does not stop an UPDATE/DELETE from mutating a
-- row in place; these triggers make the intended immutability an actual
-- database guarantee, not just an application convention. Every one of them
-- allows exactly the "genuinely required, explicitly controlled"
-- pre-publication correction the task called for, and nothing more:
--   * fundamental_source_snapshots: only validation_status/validation_errors
--     may change, and only while validation_status is still 'PENDING' (the
--     ingestion job validating a just-inserted record) -- every other column
--     is frozen from the moment of insert, and a validated (VALID/INVALID)
--     row is frozen completely. A correction is always a NEW row with
--     supersedes_id set, never an edit to this one.
--   * fundamental_score_results / fundamental_score_components: mutable only
--     while their own refresh_manifest has not yet reached 'published' (the
--     scoring job may legitimately need to fix a row before validation
--     passes) -- once published, or if there is no manifest at all (an
--     orphaned row has no legitimate reason to change), completely frozen.
--   * buy_setup_fundamental_score_bindings: unconditionally immutable from
--     the moment of insert -- there is no "pre-publication" state for a
--     binding at all; it is only ever created once, atomically, by
--     bind_fundamental_scores_for_refresh below.
-- ---------------------------------------------------------------------------

create or replace function enforce_fundamental_snapshot_immutability()
returns trigger language plpgsql as $$
begin
  if TG_OP = 'DELETE' then
    raise exception 'fundamental_source_snapshots rows are immutable and cannot be deleted (id=%). Corrections must insert a new row with supersedes_id pointing at this one.', OLD.id;
  end if;
  if OLD.validation_status <> 'PENDING' then
    raise exception 'fundamental_source_snapshots row % is already validated (%) and is immutable.', OLD.id, OLD.validation_status;
  end if;
  if NEW.instrument_id is distinct from OLD.instrument_id
     or NEW.exchange_symbol is distinct from OLD.exchange_symbol
     or NEW.source is distinct from OLD.source
     or NEW.source_locator is distinct from OLD.source_locator
     or NEW.period_end is distinct from OLD.period_end
     or NEW.period_type is distinct from OLD.period_type
     or NEW.consolidation is distinct from OLD.consolidation
     or NEW.audit_status is distinct from OLD.audit_status
     or NEW.publication_timestamp is distinct from OLD.publication_timestamp
     or NEW.available_from is distinct from OLD.available_from
     or NEW.timestamp_basis is distinct from OLD.timestamp_basis
     or NEW.retrieved_at is distinct from OLD.retrieved_at
     or NEW.currency is distinct from OLD.currency
     or NEW.sector_model is distinct from OLD.sector_model
     or NEW.ownership_structure is distinct from OLD.ownership_structure
     or NEW.raw_values is distinct from OLD.raw_values
     or NEW.derived_values is distinct from OLD.derived_values
     or NEW.is_exceptional_item is distinct from OLD.is_exceptional_item
     or NEW.exceptional_item_amount is distinct from OLD.exceptional_item_amount
     or NEW.supersedes_id is distinct from OLD.supersedes_id
     or NEW.checksum is distinct from OLD.checksum
  then
    raise exception 'fundamental_source_snapshots row % may only have validation_status/validation_errors updated, and only while still PENDING.', OLD.id;
  end if;
  return NEW;
end;
$$;
create trigger fundamental_source_snapshots_immutable
before update or delete on fundamental_source_snapshots
for each row execute function enforce_fundamental_snapshot_immutability();

create or replace function enforce_fundamental_score_result_immutability()
returns trigger language plpgsql as $$
declare
  v_state text;
begin
  select refresh_state into v_state from fundamental_refresh_manifests where id = OLD.refresh_manifest_id;
  if OLD.refresh_manifest_id is null or v_state = 'published' then
    raise exception 'fundamental_score_results row % is published (or unmanifested) and immutable.', OLD.id;
  end if;
  if TG_OP = 'DELETE' then return OLD; end if;
  return NEW;
end;
$$;
create trigger fundamental_score_results_immutable
before update or delete on fundamental_score_results
for each row execute function enforce_fundamental_score_result_immutability();

create or replace function enforce_fundamental_score_component_immutability()
returns trigger language plpgsql as $$
declare
  v_state text;
  v_manifest_id bigint;
begin
  select refresh_manifest_id into v_manifest_id from fundamental_score_results where id = OLD.score_result_id;
  if v_manifest_id is null then
    raise exception 'fundamental_score_components row % belongs to an unmanifested result and is immutable.', OLD.id;
  end if;
  select refresh_state into v_state from fundamental_refresh_manifests where id = v_manifest_id;
  if v_state = 'published' then
    raise exception 'fundamental_score_components row % belongs to a published result and is immutable.', OLD.id;
  end if;
  if TG_OP = 'DELETE' then return OLD; end if;
  return NEW;
end;
$$;
create trigger fundamental_score_components_immutable
before update or delete on fundamental_score_components
for each row execute function enforce_fundamental_score_component_immutability();

create or replace function enforce_fundamental_score_binding_immutability()
returns trigger language plpgsql as $$
begin
  raise exception 'buy_setup_fundamental_score_bindings rows are permanently immutable once created (run_id=%, instrument_id=%).', OLD.run_id, OLD.instrument_id;
end;
$$;
create trigger fundamental_score_bindings_immutable
before update or delete on buy_setup_fundamental_score_bindings
for each row execute function enforce_fundamental_score_binding_immutability();

-- ---------------------------------------------------------------------------
-- REVISED 2026-09-16 -- resolves and permanently records the fundamental
-- binding for every published screening run newly eligible for a
-- just-published fundamental refresh. Mirrors
-- services/pipeline/src/fundamentals/binding.js's resolveFundamentalBinding()
-- exactly (see that file's own tests): among every fundamental_score_results
-- row for an instrument, across every score version, the one with the
-- latest cutoff_at that is <= the run's own as_of_timestamp wins; a tie on
-- cutoff_at is broken by the higher score_version_id. `on conflict do
-- nothing` makes this idempotent and safe to call repeatedly -- a run that
-- already has a binding is never touched again (enforced twice over: by
-- this clause, and by the trigger above even if this clause were removed).
-- Called by the (not-yet-built) fundamental publish RPC after it flips a
-- refresh_manifest to 'published' -- never by the technical screening loop,
-- preserving the independence guarantee (screening-rules.js,
-- three-timeframe-gate.js, and publish_buy_setup_enrichment never call this
-- or reference any fundamental_* table).
--
-- REVISED 2026-09-16 (correction 5) -- two hardening fixes:
--   1. p_refresh_manifest_id itself is verified to exist AND be published
--      before anything else runs -- calling this with a pending/processing/
--      validation_failed/nonexistent manifest id now raises, rather than
--      silently binding nothing (which would look identical to "there was
--      nothing new to bind" from the caller's side).
--   2. The best_match CTE now joins fundamental_refresh_manifests and
--      requires refresh_state = 'published' on the CANDIDATE result too,
--      not only on the refresh that triggered this call. Previously a
--      processing/validation_failed/orphaned (refresh_manifest_id is null)
--      row for the same instrument could still win the "latest cutoff"
--      ordering purely on cutoff_at/score_version_id, ahead of an older but
--      actually-published row -- this closes that gap.
-- ---------------------------------------------------------------------------

create or replace function bind_fundamental_scores_for_refresh(p_refresh_manifest_id bigint)
returns integer
language plpgsql
set search_path to 'public', 'pg_temp'
as $function$
declare
  v_bound_count integer := 0;
  v_manifest_state text;
begin
  select refresh_state into v_manifest_state from fundamental_refresh_manifests where id = p_refresh_manifest_id;
  if v_manifest_state is null then
    raise exception 'bind_fundamental_scores_for_refresh: no fundamental_refresh_manifests row with id %', p_refresh_manifest_id;
  end if;
  if v_manifest_state <> 'published' then
    raise exception 'bind_fundamental_scores_for_refresh: manifest % is not published (refresh_state=%)', p_refresh_manifest_id, v_manifest_state;
  end if;

  with refreshed_instruments as (
    select distinct instrument_id from fundamental_score_results where refresh_manifest_id = p_refresh_manifest_id
  ),
  candidate_runs as (
    select sr.id as run_id, sr.as_of_timestamp, ri.instrument_id
    from screening_runs sr
    cross join refreshed_instruments ri
    where sr.publication_state = 'published'
      and not exists (
        select 1 from buy_setup_fundamental_score_bindings b
        where b.run_id = sr.id and b.instrument_id = ri.instrument_id
      )
  ),
  best_match as (
    select distinct on (cr.run_id, cr.instrument_id)
      cr.run_id, cr.instrument_id, r.id as result_id
    from candidate_runs cr
    join fundamental_score_results r
      on r.instrument_id = cr.instrument_id and r.cutoff_at <= cr.as_of_timestamp
    join fundamental_refresh_manifests frm
      on frm.id = r.refresh_manifest_id and frm.refresh_state = 'published'
    order by cr.run_id, cr.instrument_id, r.cutoff_at desc, r.score_version_id desc
  ),
  inserted as (
    insert into buy_setup_fundamental_score_bindings (run_id, instrument_id, fundamental_score_result_id)
    select run_id, instrument_id, result_id from best_match
    on conflict (run_id, instrument_id) do nothing
    returning 1
  )
  select count(*) into v_bound_count from inserted;
  return v_bound_count;
end;
$function$;

-- ---------------------------------------------------------------------------
-- REVISED 2026-09-16 (correction 6) -- the mirror-image entry point.
-- bind_fundamental_scores_for_refresh (above) handles the common case: a
-- fundamental refresh publishes, and every ALREADY-published screening run
-- becomes newly eligible for it. But a screening run can also publish
-- FIRST, before the fundamental side catches up -- that run needs the exact
-- same binding resolved the moment IT publishes, against whatever
-- fundamental results are already published at that time. This function is
-- that other direction: identical selection logic (latest cutoff_at <=
-- as_of_timestamp, wins ties on score_version_id, only published-manifest
-- candidates, `on conflict do nothing`, one permanent binding per
-- instrument), just keyed from a single run_id instead of a
-- refresh_manifest_id. A screening run's own universe comes from
-- run_universe_instruments (the same table 0011's
-- publish_buy_setup_enrichment reads to count expected equities), excluding
-- index rows exactly as buy_setup_analysis_ledger already does. Called by
-- the (not-yet-built) screening-run publish step immediately after it flips
-- publication_state to 'published' -- never by the technical screening
-- loop itself, preserving the same independence guarantee as the sibling
-- function above. Running this against a run that already has some/all of
-- its bindings is safe and a no-op for those instruments (`on conflict do
-- nothing` plus the trigger-enforced immutability on the table itself).
-- ---------------------------------------------------------------------------

create or replace function bind_fundamental_scores_for_run(p_run_id uuid)
returns integer
language plpgsql
set search_path to 'public', 'pg_temp'
as $function$
declare
  v_bound_count integer := 0;
  v_as_of_timestamp timestamptz;
  v_publication_state text;
begin
  select as_of_timestamp, publication_state::text into v_as_of_timestamp, v_publication_state
  from screening_runs where id = p_run_id;
  if v_publication_state is null then
    raise exception 'bind_fundamental_scores_for_run: no screening_runs row with id %', p_run_id;
  end if;
  if v_publication_state <> 'published' then
    raise exception 'bind_fundamental_scores_for_run: run % is not published (publication_state=%)', p_run_id, v_publication_state;
  end if;

  with run_instruments as (
    select instrument_id from run_universe_instruments where run_id = p_run_id and not is_index
  ),
  candidates as (
    select ri.instrument_id
    from run_instruments ri
    where not exists (
      select 1 from buy_setup_fundamental_score_bindings b
      where b.run_id = p_run_id and b.instrument_id = ri.instrument_id
    )
  ),
  best_match as (
    select distinct on (c.instrument_id)
      c.instrument_id, r.id as result_id
    from candidates c
    join fundamental_score_results r
      on r.instrument_id = c.instrument_id and r.cutoff_at <= v_as_of_timestamp
    join fundamental_refresh_manifests frm
      on frm.id = r.refresh_manifest_id and frm.refresh_state = 'published'
    order by c.instrument_id, r.cutoff_at desc, r.score_version_id desc
  ),
  inserted as (
    insert into buy_setup_fundamental_score_bindings (run_id, instrument_id, fundamental_score_result_id)
    select p_run_id, instrument_id, result_id from best_match
    on conflict (run_id, instrument_id) do nothing
    returning 1
  )
  select count(*) into v_bound_count from inserted;
  return v_bound_count;
end;
$function$;

-- ---------------------------------------------------------------------------
-- Extend buy_setup_analysis_ledger (0011) additively for display only. Every
-- existing column, join, and row is unchanged -- this appends five new
-- columns via a plain LEFT JOIN (not a dynamic ORDER BY) against the
-- immutable binding table:
--   1. Never duplicates a ledger row (buy_setup_fundamental_score_bindings
--      has a primary key of (run_id, instrument_id), so this join can only
--      ever attach zero or one fundamental result per ledger row --
--      preserving the existing one-row-per-instrument / 501-stock
--      reconciliation).
--   2. Is now fully deterministic and immutable per run (REVISED
--      2026-09-16, correction 1): the binding was resolved ONCE by
--      bind_fundamental_scores_for_refresh and is trigger-enforced
--      immutable -- this view no longer decides "which result applies," it
--      only follows an already-permanent decision. A run with no binding
--      row shows NO_DATA, never a dynamically-recomputed guess.
--   3. Is completely independent of the gate/qualification columns above --
--      no existing column's value or computation changes.
-- `create or replace view` requires the existing column list/types to be
-- preserved with new columns only appended at the end, which this does.
-- ---------------------------------------------------------------------------

create or replace view buy_setup_analysis_ledger with (security_invoker = true) as
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
  max(ind.evidence_candle_ts) as evidence_timestamp,
  -- Fundamental score overlay (additive; independent of every column above).
  -- Resolved via the immutable binding, never a dynamic "latest" lookup.
  max(fsr.total_score) as fundamental_score,
  max(fsr.grade) as fundamental_grade,
  max(fsr.coverage_percentage) as fundamental_coverage_percentage,
  max(fsr.terminal_status) as fundamental_data_status,
  max(fsr.sector_model) as fundamental_sector_model,
  max(fsr.cutoff_at) as fundamental_as_of,
  max(fsr.score_version) as fundamental_score_version
from instrument_run_results irr
join instruments i on i.id = irr.instrument_id
join screening_runs sr on sr.id = irr.run_id
left join rule_traces rt on rt.run_id = irr.run_id and rt.instrument_id = irr.instrument_id and rt.rule_id in ('BSP-M1', 'BSP-M3')
left join buy_setup_gate_traces bgt on bgt.run_id = irr.run_id and bgt.instrument_id = irr.instrument_id and bgt.rule_id in ('BSA-D1', 'BSA-G1')
left join buy_setup_fifteen_minute_wave w on w.run_id = irr.run_id and w.instrument_id = irr.instrument_id
left join buy_setup_divergence_evidence d on d.run_id = irr.run_id and d.instrument_id = irr.instrument_id
left join buy_setup_intraday_indicators ind on ind.run_id = irr.run_id and ind.instrument_id = irr.instrument_id
left join buy_setup_fundamental_score_bindings fb on fb.run_id = irr.run_id and fb.instrument_id = irr.instrument_id
left join fundamental_score_results fsr on fsr.id = fb.fundamental_score_result_id
where not irr.is_index
group by irr.run_id, irr.instrument_id, i.symbol, i.name;
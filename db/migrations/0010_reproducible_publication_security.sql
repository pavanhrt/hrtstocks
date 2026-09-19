-- Originally authored for Supabase; made self-contained for plain PostgreSQL / Cloud SQL (see docs/gcp/schema-provenance.md).
-- Supabase-only statements (RLS, policies, role grants, auth/storage/cron) were removed or replaced.

-- Forward-only contract for reproducible runs and transactional publication.
-- This file does not rewrite applied migrations or mutate historical results.

create type publication_state as enum ('processing', 'validated', 'published', 'validation_failed');

alter table screening_runs
  add column as_of_timestamp timestamptz,
  add column publication_state publication_state not null default 'processing',
  add column validated_at timestamptz,
  add column published_at timestamptz,
  add column analysis_provider text,
  add column analysis_adjustment_state text,
  add column analysis_series_version text,
  add column data_provenance jsonb not null default '{}';

comment on column screening_runs.as_of_timestamp is
  'Immutable market-data cutoff. Required by publish_screening_run for all new publications; historical rows remain null rather than receiving an invented cutoff.';

create table run_universe_sources (
  run_id uuid not null references screening_runs(id) on delete cascade,
  index_id text not null references instruments(id),
  provider text not null,
  retrieved_at timestamptz not null,
  constituent_count integer not null check (constituent_count > 0),
  source_uri text not null,
  content_hash text not null check (content_hash ~ '^[a-f0-9]{64}$'),
  primary key (run_id, index_id)
);

create table run_universe_instruments (
  run_id uuid not null references screening_runs(id) on delete cascade,
  instrument_id text not null references instruments(id),
  is_index boolean not null,
  membership_tags text[] not null default '{}',
  primary key (run_id, instrument_id)
);
create index run_universe_instruments_equities_idx on run_universe_instruments (run_id, is_index);

create table analysis_bars (
  run_id uuid not null references screening_runs(id) on delete cascade,
  instrument_id text not null references instruments(id),
  interval text not null check (interval in ('1d', '1h')),
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
  is_complete boolean not null,
  source_retrieved_at timestamptz,
  created_at timestamptz not null default now(),
  primary key (run_id, instrument_id, interval, ts),
  check (high >= low and close between low and high)
);
create index analysis_bars_cutoff_idx on analysis_bars (run_id, ts desc);

alter table instrument_direction_runs add column chart_content_hash text;
alter table swing_analysis_results
  add column daily_chart_object_path text,
  add column daily_chart_content_hash text,
  add column hourly_chart_object_path text,
  add column hourly_chart_content_hash text;

alter table swing_analysis_rule_traces
  add column required_condition text,
  add column evidence_timestamp timestamptz,
  add column data_quality data_quality_state;

create table pipeline_persistence_errors (
  id bigint generated always as identity primary key,
  run_id uuid not null references screening_runs(id) on delete cascade,
  instrument_id text references instruments(id),
  stage text not null,
  message text not null,
  created_at timestamptz not null default now()
);
create index pipeline_persistence_errors_run_idx on pipeline_persistence_errors (run_id);

create table run_publication_manifests (
  run_id uuid primary key references screening_runs(id) on delete cascade,
  expected_equities integer not null,
  expected_indexes integer not null,
  universe_sources integer not null,
  result_equities integer not null,
  result_indexes integer not null,
  eligible_equities integer not null,
  alignment_equities integer not null,
  direction_rows integer not null,
  chart_rows integer not null,
  analysis_bar_equities integer not null,
  trace_equities integer not null,
  missing_aligned_analysis integer not null,
  missing_storage_objects integer not null,
  critical_persistence_errors integer not null,
  future_analysis_bars integer not null,
  incomplete_analysis_bars integer not null,
  coverage_reconciled boolean not null,
  validation_errors text[] not null default '{}',
  manifest jsonb not null,
  validated_at timestamptz not null,
  published_at timestamptz
);

-- Publication is the only operation allowed to turn a processing snapshot
-- into the viewer-visible completed snapshot. All checks and the status flip
-- run in one database transaction under the service role.
create or replace function publish_screening_run(p_run_id uuid)
returns jsonb
language plpgsql
set search_path = public, storage, pg_temp
as $$
declare
  v_run screening_runs%rowtype;
  v_expected_equities integer;
  v_expected_indexes integer;
  v_universe_sources integer;
  v_result_equities integer;
  v_result_indexes integer;
  v_eligible_equities integer;
  v_alignment_equities integer;
  v_direction_rows integer;
  v_chart_rows integer;
  v_analysis_bar_equities integer;
  v_trace_equities integer;
  v_missing_aligned_analysis integer;
  v_missing_storage_objects integer;
  v_critical_persistence_errors integer;
  v_future_analysis_bars integer;
  v_incomplete_analysis_bars integer;
  v_coverage_reconciled boolean;
  v_errors text[] := '{}';
  v_manifest jsonb;
  v_now timestamptz := now();
begin
  select * into v_run from screening_runs where id = p_run_id for update;
  if not found then raise exception 'screening run % does not exist', p_run_id; end if;

  select count(*) filter (where not is_index), count(*) filter (where is_index)
    into v_expected_equities, v_expected_indexes
    from run_universe_instruments where run_id = p_run_id;
  select count(*) into v_universe_sources from run_universe_sources where run_id = p_run_id;
  select count(*) filter (where not is_index), count(*) filter (where is_index),
         count(*) filter (where not is_index and data_quality = 'PASS')
    into v_result_equities, v_result_indexes, v_eligible_equities
    from instrument_run_results where run_id = p_run_id;
  select count(*) into v_alignment_equities
    from instrument_alignment a join run_universe_instruments u
      on u.run_id = a.run_id and u.instrument_id = a.instrument_id
    where a.run_id = p_run_id and not u.is_index;
  select count(*) into v_direction_rows
    from instrument_direction_runs d join instrument_run_results r
      on r.run_id = d.run_id and r.instrument_id = d.instrument_id
    where d.run_id = p_run_id and not r.is_index and r.data_quality = 'PASS'
      and d.timeframe in ('monthly', 'weekly', 'daily');
  select count(*) into v_chart_rows
    from instrument_direction_runs d join instrument_run_results r
      on r.run_id = d.run_id and r.instrument_id = d.instrument_id
    where d.run_id = p_run_id and not r.is_index and r.data_quality = 'PASS'
      and d.timeframe in ('monthly', 'weekly', 'daily')
      and d.chart_object_path is not null and d.chart_content_hash is not null;
  select count(distinct b.instrument_id) into v_analysis_bar_equities
    from analysis_bars b join instrument_run_results r
      on r.run_id = b.run_id and r.instrument_id = b.instrument_id
    where b.run_id = p_run_id and b.interval = '1d' and not r.is_index and r.data_quality = 'PASS';
  select count(distinct t.instrument_id) into v_trace_equities
    from rule_traces t join instrument_run_results r
      on r.run_id = t.run_id and r.instrument_id = t.instrument_id
    where t.run_id = p_run_id and not r.is_index and r.data_quality = 'PASS';
  select count(*) into v_missing_aligned_analysis
    from instrument_alignment a
    where a.run_id = p_run_id
      and a.final_alignment in ('ALIGNED_BULLISH', 'ALIGNED_BEARISH')
      and not exists (
        select 1 from swing_analysis_results s
        where s.run_id = a.run_id and s.instrument_id = a.instrument_id
          and s.hypothesis = case when a.final_alignment = 'ALIGNED_BULLISH' then 'bullish' else 'bearish' end
      );
  with referenced_paths as (
    select chart_object_path as object_path from instrument_direction_runs
      where run_id = p_run_id and chart_object_path is not null
    union
    select daily_chart_object_path from swing_analysis_results
      where run_id = p_run_id and daily_chart_object_path is not null
    union
    select hourly_chart_object_path from swing_analysis_results
      where run_id = p_run_id and hourly_chart_object_path is not null
  )
  select count(*) into v_missing_storage_objects
    from referenced_paths p left join stored_objects o
      on o.bucket = 'direction-charts' and o.name = p.object_path
    where o.name is null;
  select count(*) into v_critical_persistence_errors from pipeline_persistence_errors where run_id = p_run_id;
  select count(*) filter (where ts > v_run.as_of_timestamp), count(*) filter (where not is_complete)
    into v_future_analysis_bars, v_incomplete_analysis_bars
    from analysis_bars where run_id = p_run_id;
  select coalesce((select reconciled from coverage_reconciliation where run_id = p_run_id), false)
    into v_coverage_reconciled;

  if v_run.as_of_timestamp is null then v_errors := array_append(v_errors, 'frozen cutoff is missing'); end if;
  if v_expected_equities <= 0 then v_errors := array_append(v_errors, 'expected equity universe is empty'); end if;
  if v_expected_indexes <> 4 then v_errors := array_append(v_errors, format('expected 4 index instruments, found %s', v_expected_indexes)); end if;
  if v_universe_sources <> 4 then v_errors := array_append(v_errors, format('expected 4 universe snapshots, found %s', v_universe_sources)); end if;
  if v_result_equities <> v_expected_equities then v_errors := array_append(v_errors, 'equity result count does not match expected universe'); end if;
  if v_result_indexes <> v_expected_indexes then v_errors := array_append(v_errors, 'index result count does not match expected universe'); end if;
  if v_alignment_equities <> v_expected_equities then v_errors := array_append(v_errors, 'alignment count does not match expected universe'); end if;
  if v_direction_rows <> v_eligible_equities * 3 then v_errors := array_append(v_errors, 'eligible equities do not each have three Direction rows'); end if;
  if v_chart_rows <> v_direction_rows then v_errors := array_append(v_errors, 'one or more Direction rows lacks an immutable chart path/hash'); end if;
  if v_analysis_bar_equities <> v_eligible_equities then v_errors := array_append(v_errors, 'one or more eligible equities lacks run-scoped daily analysis bars'); end if;
  if v_trace_equities <> v_eligible_equities then v_errors := array_append(v_errors, 'one or more eligible equities lacks canonical rule traces'); end if;
  if v_missing_aligned_analysis > 0 then v_errors := array_append(v_errors, 'one or more aligned equities lacks directional Analysis'); end if;
  if v_missing_storage_objects > 0 then v_errors := array_append(v_errors, 'one or more referenced chart objects is missing'); end if;
  if v_critical_persistence_errors > 0 then v_errors := array_append(v_errors, 'critical persistence errors were recorded'); end if;
  if v_future_analysis_bars > 0 then v_errors := array_append(v_errors, 'analysis bars exceed the frozen cutoff'); end if;
  if v_incomplete_analysis_bars > 0 then v_errors := array_append(v_errors, 'incomplete analysis bars were persisted'); end if;
  if not v_coverage_reconciled then v_errors := array_append(v_errors, 'coverage reconciliation failed'); end if;

  v_manifest := jsonb_build_object(
    'run_id', p_run_id, 'as_of_timestamp', v_run.as_of_timestamp,
    'expected_equities', v_expected_equities, 'expected_indexes', v_expected_indexes,
    'universe_sources', v_universe_sources, 'result_equities', v_result_equities,
    'result_indexes', v_result_indexes, 'eligible_equities', v_eligible_equities,
    'alignment_equities', v_alignment_equities, 'direction_rows', v_direction_rows,
    'chart_rows', v_chart_rows, 'analysis_bar_equities', v_analysis_bar_equities,
    'trace_equities', v_trace_equities, 'missing_aligned_analysis', v_missing_aligned_analysis,
    'missing_storage_objects', v_missing_storage_objects,
    'critical_persistence_errors', v_critical_persistence_errors,
    'future_analysis_bars', v_future_analysis_bars,
    'incomplete_analysis_bars', v_incomplete_analysis_bars,
    'coverage_reconciled', v_coverage_reconciled, 'validation_errors', to_jsonb(v_errors)
  );

  insert into run_publication_manifests (
    run_id, expected_equities, expected_indexes, universe_sources, result_equities, result_indexes,
    eligible_equities, alignment_equities, direction_rows, chart_rows, analysis_bar_equities,
    trace_equities, missing_aligned_analysis, missing_storage_objects, critical_persistence_errors,
    future_analysis_bars, incomplete_analysis_bars, coverage_reconciled, validation_errors,
    manifest, validated_at, published_at
  ) values (
    p_run_id, v_expected_equities, v_expected_indexes, v_universe_sources, v_result_equities, v_result_indexes,
    v_eligible_equities, v_alignment_equities, v_direction_rows, v_chart_rows, v_analysis_bar_equities,
    v_trace_equities, v_missing_aligned_analysis, v_missing_storage_objects, v_critical_persistence_errors,
    v_future_analysis_bars, v_incomplete_analysis_bars, v_coverage_reconciled, v_errors,
    v_manifest, v_now, null
  ) on conflict (run_id) do update set
    expected_equities = excluded.expected_equities, expected_indexes = excluded.expected_indexes,
    universe_sources = excluded.universe_sources, result_equities = excluded.result_equities,
    result_indexes = excluded.result_indexes, eligible_equities = excluded.eligible_equities,
    alignment_equities = excluded.alignment_equities, direction_rows = excluded.direction_rows,
    chart_rows = excluded.chart_rows, analysis_bar_equities = excluded.analysis_bar_equities,
    trace_equities = excluded.trace_equities, missing_aligned_analysis = excluded.missing_aligned_analysis,
    missing_storage_objects = excluded.missing_storage_objects,
    critical_persistence_errors = excluded.critical_persistence_errors,
    future_analysis_bars = excluded.future_analysis_bars,
    incomplete_analysis_bars = excluded.incomplete_analysis_bars,
    coverage_reconciled = excluded.coverage_reconciled, validation_errors = excluded.validation_errors,
    manifest = excluded.manifest, validated_at = excluded.validated_at, published_at = null;

  if cardinality(v_errors) > 0 then
    update screening_runs set status = 'partial', publication_state = 'validation_failed',
      validated_at = v_now, completed_at = v_now where id = p_run_id;
    return jsonb_build_object('published', false, 'errors', to_jsonb(v_errors), 'manifest', v_manifest);
  end if;

  update screening_runs set publication_state = 'validated', validated_at = v_now where id = p_run_id;
  update screening_runs set status = 'completed', publication_state = 'published',
    published_at = v_now, completed_at = v_now where id = p_run_id;
  update run_publication_manifests set published_at = v_now where run_id = p_run_id;
  return jsonb_build_object('published', true, 'errors', '[]'::jsonb, 'manifest', v_manifest);
end;
$$;

create or replace function expire_stale_screening_runs(p_older_than timestamptz)
returns integer
language plpgsql
set search_path = public, pg_temp
as $$
declare
  v_run_id uuid;
  v_count integer := 0;
begin
  for v_run_id in
    select id from screening_runs
    where status in ('queued', 'running') and created_at < p_older_than
    for update skip locked
  loop
    update screening_runs set status = 'failed', publication_state = 'validation_failed',
      completed_at = now() where id = v_run_id;
    insert into pipeline_audit_log (run_id, stage, status, message)
      values (v_run_id, 'stale_expiration', 'expired', 'Run expired by audited stale-run recovery.');
    update screening_run_leases set status = 'released', heartbeat_at = now(), expires_at = now()
      where run_id = v_run_id;
    v_count := v_count + 1;
  end loop;
  return v_count;
end;
$$;
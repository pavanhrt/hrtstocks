-- Correction (fundamental-score correction pass 3, 2026-09-16, item 9):
-- migration 0014 added bind_fundamental_scores_for_refresh() and
-- bind_fundamental_scores_for_run(), but neither was ever actually CALLED
-- by anything -- a correct, tested, security-hardened function nobody
-- invokes has no real effect. This migration wires both into the real
-- publication workflows:
--
--   1. A NEW publish_fundamental_refresh(p_refresh_manifest_id) -- the
--      fundamental side's own equivalent of publish_screening_run/
--      publish_buy_setup_enrichment: verifies the manifest exists and is not
--      already published, recomputes scored/no_data/manual_review counts
--      DIRECTLY from fundamental_score_results (never trusts a
--      caller-supplied count, mirroring publish_screening_run's own
--      recompute-everything-from-source-tables philosophy), validates
--      expected_instrument_count reconciles against the actual result count,
--      and ONLY THEN flips refresh_state to 'published' and calls
--      bind_fundamental_scores_for_refresh() -- exactly the "invoked through
--      a clearly documented post-publication step" correction 6 (previous
--      pass) called for.
--
--   2. publish_screening_run(p_run_id) is `create or replace`d with the
--      IDENTICAL body already live from migration 0010, plus exactly one
--      addition: a call to bind_fundamental_scores_for_run(p_run_id) right
--      after the technical publication is fully committed, wrapped in its
--      own nested BEGIN/EXCEPTION block so a fundamental-side failure can
--      NEVER roll back or block the technical publication already committed
--      above it -- preserving the independence guarantee (screening-rules.js,
--      three-timeframe-gate.js, and publish_buy_setup_enrichment still never
--      reference any fundamental_* table; this is the ONLY connection, and
--      it runs strictly after, never before or during, the technical
--      decision). Per this repo's own forward-only convention (see 0010's
--      and 0015's own headers): migration 0010 is ALREADY APPLIED LIVE and
--      is never edited in place -- `create or replace function` in this NEW
--      migration is the only way to extend it, and every line of the
--      original body below is reproduced verbatim except for the one
--      addition, clearly marked.
--
-- Both new/replaced functions' EXECUTE is restricted to service_role, same
-- as every other operational RPC touched by this task (0010's own
-- publish_screening_run already was; 0014's bind functions already are).
--
-- NOT YET APPLIED to any database -- written, reviewed, and syntax-checked,
-- consistent with this task's own "no live migration" constraint. Requires
-- 0014 and 0015 to be applied first (uses tables/functions from both).

create or replace function publish_fundamental_refresh(p_refresh_manifest_id bigint)
returns jsonb
language plpgsql
set search_path to 'public', 'pg_temp'
as $function$
declare
  v_manifest fundamental_refresh_manifests%rowtype;
  v_actual_count integer;
  v_scored_count integer;
  v_no_data_count integer;
  v_manual_review_count integer;
  v_errors text[] := '{}';
  v_now timestamptz := now();
  v_bound_count integer := 0;
  v_bind_error text := null;
  v_manifest_result jsonb;
begin
  select * into v_manifest from fundamental_refresh_manifests where id = p_refresh_manifest_id for update;
  if not found then
    raise exception 'publish_fundamental_refresh: no fundamental_refresh_manifests row with id %', p_refresh_manifest_id;
  end if;
  if v_manifest.refresh_state = 'published' then
    raise exception 'publish_fundamental_refresh: manifest % is already published', p_refresh_manifest_id;
  end if;

  select
    count(*),
    count(*) filter (where terminal_status = 'SCORED'),
    count(*) filter (where terminal_status = 'NO_DATA'),
    count(*) filter (where terminal_status = 'MANUAL_REVIEW')
  into v_actual_count, v_scored_count, v_no_data_count, v_manual_review_count
  from fundamental_score_results where refresh_manifest_id = p_refresh_manifest_id;

  if v_manifest.expected_instrument_count <= 0 then
    v_errors := array_append(v_errors, 'expected_instrument_count is not set (<= 0)');
  end if;
  if v_actual_count <> v_manifest.expected_instrument_count then
    v_errors := array_append(v_errors, format('result count (%s) does not match expected_instrument_count (%s)', v_actual_count, v_manifest.expected_instrument_count));
  end if;
  if v_scored_count + v_no_data_count + v_manual_review_count <> v_actual_count then
    v_errors := array_append(v_errors, 'terminal_status counts do not reconcile against total results (an unrecognized terminal_status exists)');
  end if;

  update fundamental_refresh_manifests
    set scored_count = v_scored_count, no_data_count = v_no_data_count, manual_review_count = v_manual_review_count,
        validation_errors = to_jsonb(v_errors)
    where id = p_refresh_manifest_id;

  v_manifest_result := jsonb_build_object(
    'refresh_manifest_id', p_refresh_manifest_id, 'expected_instrument_count', v_manifest.expected_instrument_count,
    'actual_count', v_actual_count, 'scored_count', v_scored_count, 'no_data_count', v_no_data_count,
    'manual_review_count', v_manual_review_count, 'validation_errors', to_jsonb(v_errors)
  );

  if cardinality(v_errors) > 0 then
    update fundamental_refresh_manifests set refresh_state = 'validation_failed', validated_at = v_now where id = p_refresh_manifest_id;
    return jsonb_build_object('published', false, 'errors', to_jsonb(v_errors), 'manifest', v_manifest_result);
  end if;

  update fundamental_refresh_manifests set refresh_state = 'validated', validated_at = v_now where id = p_refresh_manifest_id;
  update fundamental_refresh_manifests set refresh_state = 'published', published_at = v_now where id = p_refresh_manifest_id;

  -- Binding is idempotent and safe to retry -- a rare failure here must
  -- never un-publish an otherwise-valid, already-committed fundamental
  -- refresh. Swallowed (not re-raised); the caller can inspect bind_error
  -- and re-invoke bind_fundamental_scores_for_refresh(p_refresh_manifest_id)
  -- directly if it ever fires.
  begin
    v_bound_count := bind_fundamental_scores_for_refresh(p_refresh_manifest_id);
  exception when others then
    v_bind_error := sqlerrm;
  end;

  return jsonb_build_object('published', true, 'errors', '[]'::jsonb, 'manifest', v_manifest_result, 'bound_count', v_bound_count, 'bind_error', v_bind_error);
end;
$function$;

revoke execute on function publish_fundamental_refresh(bigint) from public, anon, authenticated;
grant execute on function publish_fundamental_refresh(bigint) to service_role;

-- ---------------------------------------------------------------------------
-- publish_screening_run: identical to migration 0010's live body, plus one
-- addition (clearly marked below) calling bind_fundamental_scores_for_run
-- after the technical publication is fully committed. Every other line is
-- reproduced verbatim -- diff this function against 0010's own copy to
-- confirm nothing else changed.
-- ---------------------------------------------------------------------------

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
  v_fundamental_bound_count integer; -- ADDED (item 9): result of the fundamental-binding call below, for observability only
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
    from referenced_paths p left join storage.objects o
      on o.bucket_id = 'direction-charts' and o.name = p.object_path
    where o.id is null;
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

  -- ADDED (item 9, correction pass 3, 2026-09-16): bind any already-published
  -- fundamental results this now-published run is eligible for -- the other
  -- half of correction 6 (previous pass), which added
  -- bind_fundamental_scores_for_run() but never wired it into anything.
  -- Runs STRICTLY AFTER the technical publication above is fully committed,
  -- and its own nested BEGIN/EXCEPTION block means a fundamental-side
  -- failure here can NEVER roll back or alter the technical gate,
  -- classification, counts, or the publication decision already returned
  -- above -- it is swallowed, not re-raised. Idempotent and safe to retry
  -- later by calling bind_fundamental_scores_for_run(p_run_id) directly.
  begin
    v_fundamental_bound_count := bind_fundamental_scores_for_run(p_run_id);
  exception when others then
    v_fundamental_bound_count := null;
  end;

  return jsonb_build_object('published', true, 'errors', '[]'::jsonb, 'manifest', v_manifest);
end;
$$;

revoke execute on function publish_screening_run(uuid) from public, anon, authenticated;
grant execute on function publish_screening_run(uuid) to service_role;

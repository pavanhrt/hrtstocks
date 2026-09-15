-- Fixes two deployment bugs found while running analyze-buy-setup for the
-- first time (2026-09-15), immediately after 0012's lease-seed fix.
--
-- Bug 1: publish_buy_setup_enrichment(uuid) (migration 0011) raised
-- "42702: column reference \"instrument_id\" is ambiguous" on every call,
-- because its divergence-coverage subquery joins
-- buy_setup_divergence_evidence d to buy_setup_gate_traces g -- both have an
-- instrument_id column -- and referenced the bare column name instead of
-- qualifying it with d.instrument_id. Confirmed live: calling
-- `select publish_buy_setup_enrichment('<run_id>')` directly reproduced this
-- exact error at "line 47 at SQL statement". The Edge Function's own error
-- handling separately stringified this failure as the unhelpful
-- "[object Object]" (a plain PostgREST error object is not a JS Error
-- instance, so `err instanceof Error ? err.message : String(err)` fell
-- through to String() on an object) -- fixed in the same commit as this
-- migration, in supabase/functions/analyze-buy-setup/index.ts.
--
-- Bug 2: the function's own UPDATE never set
-- buy_setup_manifests.fifteen_minute_completed_count -- it stayed frozen at
-- the initial INSERT's default of 0 forever, so the page's "15-minute
-- analysis completed" summary card could never reflect real progress even
-- after a successful publish. Fixed by setting it to the minimum across all
-- five per-instrument completion checks already computed above (indicators,
-- daily chart-structure, daily chart, 15-minute chart, divergence
-- evidence) -- an instrument only counts as "15-minute analysis completed"
-- once every one of those pieces of evidence exists for it.
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
  select count(distinct d.instrument_id) into v_qualified_with_divergence
    from buy_setup_divergence_evidence d join buy_setup_gate_traces g
      on g.run_id = d.run_id and g.instrument_id = d.instrument_id and g.rule_id = 'BSA-G1' and g.result = 'PASS'
    where d.run_id = p_run_id
    group by d.run_id having count(distinct d.indicator) = 2;
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
    fifteen_minute_completed_count = least(
      v_qualified_with_indicators, v_qualified_with_daily_levels, v_qualified_with_daily_chart,
      v_qualified_with_intraday_chart, v_qualified_with_divergence
    ),
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

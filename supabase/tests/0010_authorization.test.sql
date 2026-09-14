begin;

select plan(44);

select has_column('public', 'screening_runs', 'as_of_timestamp');
select has_column('public', 'screening_runs', 'publication_state');
select has_column('public', 'screening_runs', 'analysis_provider');
select has_column('public', 'screening_runs', 'analysis_adjustment_state');
select has_column('public', 'screening_runs', 'analysis_series_version');
select has_column('public', 'screening_runs', 'data_provenance');
select has_column('public', 'instrument_direction_runs', 'chart_content_hash');
select has_column('public', 'swing_analysis_results', 'daily_chart_object_path');
select has_column('public', 'swing_analysis_results', 'daily_chart_content_hash');
select has_column('public', 'swing_analysis_results', 'hourly_chart_object_path');
select has_column('public', 'swing_analysis_results', 'hourly_chart_content_hash');
select has_column('public', 'swing_analysis_rule_traces', 'required_condition');
select has_column('public', 'swing_analysis_rule_traces', 'evidence_timestamp');
select has_column('public', 'swing_analysis_rule_traces', 'data_quality');

select has_table('public', 'run_universe_sources');
select has_table('public', 'run_universe_instruments');
select has_table('public', 'analysis_bars');
select has_table('public', 'pipeline_persistence_errors');
select has_table('public', 'run_publication_manifests');
select has_column('public', 'run_publication_manifests', 'universe_sources');
select has_column('public', 'run_publication_manifests', 'incomplete_analysis_bars');

select ok((select relrowsecurity from pg_class where oid = 'public.run_universe_sources'::regclass), 'run_universe_sources has RLS enabled');
select ok((select relrowsecurity from pg_class where oid = 'public.run_universe_instruments'::regclass), 'run_universe_instruments has RLS enabled');
select ok((select relrowsecurity from pg_class where oid = 'public.analysis_bars'::regclass), 'analysis_bars has RLS enabled');
select ok((select relrowsecurity from pg_class where oid = 'public.pipeline_persistence_errors'::regclass), 'pipeline_persistence_errors has RLS enabled');
select ok((select relrowsecurity from pg_class where oid = 'public.run_publication_manifests'::regclass), 'run_publication_manifests has RLS enabled');

select ok(
  not has_table_privilege('anon', 'public.analysis_bars', 'SELECT')
  and has_table_privilege('authenticated', 'public.analysis_bars', 'SELECT')
  and not has_table_privilege('authenticated', 'public.analysis_bars', 'INSERT,UPDATE,DELETE'),
  'analysis_bars is authenticated-read-only and inaccessible to anon'
);

select has_function('public', 'publish_screening_run', array['uuid']);
select has_function('public', 'expire_stale_screening_runs', array['timestamp with time zone']);
select ok(has_function_privilege('service_role', 'public.publish_screening_run(uuid)', 'EXECUTE'), 'service role can publish a validated run');
select ok(not has_function_privilege('authenticated', 'public.publish_screening_run(uuid)', 'EXECUTE'), 'authenticated users cannot publish runs directly');
select ok(has_function_privilege('service_role', 'public.expire_stale_screening_runs(timestamp with time zone)', 'EXECUTE'), 'service role can expire stale runs');
select ok(not has_function_privilege('authenticated', 'public.expire_stale_screening_runs(timestamp with time zone)', 'EXECUTE'), 'authenticated users cannot expire runs directly');
select ok(not has_function_privilege('authenticated', 'public.claim_next_pipeline_batch(uuid)', 'EXECUTE'), 'authenticated users cannot claim pipeline work');
select ok(not has_function_privilege('authenticated', 'public.reset_stale_pipeline_batches(uuid,integer,integer)', 'EXECUTE'), 'authenticated users cannot reset pipeline work');
select ok(not has_function_privilege('authenticated', 'public.try_acquire_rate_limit_slot(text,timestamp with time zone,integer)', 'EXECUTE'), 'authenticated users cannot consume provider rate slots');
select ok(not has_table_privilege('anon', 'public.run_publication_manifests', 'SELECT'), 'anonymous users cannot read publication manifests');

-- ---------------------------------------------------------------------------
-- Authorization hardening (explicitly approved after risk disclosure).
-- Structural assertions only: simulating an authenticated auth.uid()/JWT
-- session inside pgTAP requires inserting into auth.users, which this suite
-- deliberately avoids. These checks instead verify the actual policy
-- definitions and grants installed by the migration, which is what a broken
-- migration would get wrong.
-- ---------------------------------------------------------------------------

select ok(
  not exists (
    select 1 from (values
      ('public','profiles','profiles_self_or_admin_select'),
      ('public','profiles','profiles_admin_update'),
      ('public','strategy_versions','strategy_versions_read'),
      ('public','rule_definitions','rule_definitions_read'),
      ('public','parameter_versions','parameter_versions_read'),
      ('public','instruments','instruments_read'),
      ('public','index_memberships','index_memberships_read'),
      ('public','market_bars_raw','market_bars_raw_read'),
      ('public','market_bars_adjusted','market_bars_adjusted_read'),
      ('public','corporate_actions','corporate_actions_read'),
      ('public','data_quality_results','data_quality_results_read'),
      ('public','derivative_contracts','derivative_contracts_read'),
      ('public','derivative_snapshots','derivative_snapshots_read'),
      ('public','pipeline_audit_log','pipeline_audit_log_read'),
      ('public','screening_run_leases','screening_run_leases_read'),
      ('public','pipeline_batches','pipeline_batches_read'),
      ('public','provider_rate_limit_buckets','provider_rate_limit_buckets_read'),
      ('public','instrument_direction','instrument_direction_read'),
      ('storage','objects','direction_charts_read'),
      ('public','screening_runs','screening_runs_read'),
      ('public','instrument_run_results','instrument_run_results_read'),
      ('public','rule_traces','rule_traces_read'),
      ('public','rankings','rankings_read'),
      ('public','coverage_reconciliation','coverage_reconciliation_read'),
      ('public','instrument_direction_runs','instrument_direction_runs_read'),
      ('public','direction_pivots','direction_pivots_read'),
      ('public','elliott_hypotheses','elliott_hypotheses_read'),
      ('public','pattern_detections','pattern_detections_read'),
      ('public','instrument_alignment','instrument_alignment_read'),
      ('public','swing_analysis_results','swing_analysis_results_read'),
      ('public','swing_analysis_rule_traces','swing_analysis_rule_traces_read'),
      ('public','run_universe_sources','run_universe_sources_read'),
      ('public','run_universe_instruments','run_universe_instruments_read'),
      ('public','analysis_bars','analysis_bars_read'),
      ('public','pipeline_persistence_errors','pipeline_persistence_errors_read'),
      ('public','run_publication_manifests','run_publication_manifests_read')
    ) as expected(schemaname, tablename, policyname)
    left join pg_policies p
      on p.schemaname = expected.schemaname and p.tablename = expected.tablename and p.policyname = expected.policyname
    where p.policyname is null or p.roles is distinct from array['authenticated']::name[]
  ),
  'every hardened read policy is scoped to exactly {authenticated}, not PUBLIC'
);

select ok(
  not exists (
    select 1 from (values
      ('public','screening_runs','screening_runs_read'),
      ('public','instrument_run_results','instrument_run_results_read'),
      ('public','rule_traces','rule_traces_read'),
      ('public','rankings','rankings_read'),
      ('public','coverage_reconciliation','coverage_reconciliation_read'),
      ('public','instrument_direction_runs','instrument_direction_runs_read'),
      ('public','direction_pivots','direction_pivots_read'),
      ('public','elliott_hypotheses','elliott_hypotheses_read'),
      ('public','pattern_detections','pattern_detections_read'),
      ('public','instrument_alignment','instrument_alignment_read'),
      ('public','swing_analysis_results','swing_analysis_results_read'),
      ('public','swing_analysis_rule_traces','swing_analysis_rule_traces_read'),
      ('public','run_universe_sources','run_universe_sources_read'),
      ('public','run_universe_instruments','run_universe_instruments_read'),
      ('public','run_publication_manifests','run_publication_manifests_read')
    ) as expected(schemaname, tablename, policyname)
    left join pg_policies p
      on p.schemaname = expected.schemaname and p.tablename = expected.tablename and p.policyname = expected.policyname
    where p.policyname is null or p.qual not ilike '%publication_state%'
  ),
  'every run-scoped Viewer-visible policy gates on publication_state, not status'
);

select ok(
  not exists (
    select 1 from unnest(array[
      'strategy_versions','rule_definitions','parameter_versions','instruments','index_memberships',
      'market_bars_raw','market_bars_adjusted','corporate_actions','data_quality_results',
      'derivative_contracts','derivative_snapshots','pipeline_audit_log',
      'screening_runs','instrument_run_results','rule_traces','rankings','coverage_reconciliation',
      'instrument_direction','screening_run_leases','pipeline_batches','instrument_direction_runs',
      'direction_pivots','elliott_hypotheses','pattern_detections','instrument_alignment',
      'swing_analysis_results','swing_analysis_rule_traces','provider_rate_limit_buckets'
    ]) as t(tablename)
    where has_table_privilege('anon', 'public.' || t.tablename, 'SELECT')
  ),
  'anon has no SELECT grant on any hardened computed/pipeline table'
);

select ok(
  not exists (
    select 1 from unnest(array[
      'strategy_versions','rule_definitions','parameter_versions','instruments','index_memberships',
      'market_bars_raw','market_bars_adjusted','corporate_actions','data_quality_results',
      'derivative_contracts','derivative_snapshots','pipeline_audit_log',
      'screening_runs','instrument_run_results','rule_traces','rankings','coverage_reconciliation',
      'instrument_direction','screening_run_leases','pipeline_batches','instrument_direction_runs',
      'direction_pivots','elliott_hypotheses','pattern_detections','instrument_alignment',
      'swing_analysis_results','swing_analysis_rule_traces','provider_rate_limit_buckets'
    ]) as t(tablename)
    where has_table_privilege('anon', 'public.' || t.tablename, 'INSERT')
       or has_table_privilege('anon', 'public.' || t.tablename, 'UPDATE')
       or has_table_privilege('anon', 'public.' || t.tablename, 'DELETE')
  ),
  'anon has no write grant on any hardened computed/pipeline table'
);

select ok(
  not exists (
    select 1 from unnest(array[
      'strategy_versions','rule_definitions','parameter_versions','instruments','index_memberships',
      'market_bars_raw','market_bars_adjusted','corporate_actions','data_quality_results',
      'derivative_contracts','derivative_snapshots','pipeline_audit_log',
      'screening_runs','instrument_run_results','rule_traces','rankings','coverage_reconciliation',
      'instrument_direction','screening_run_leases','pipeline_batches','instrument_direction_runs',
      'direction_pivots','elliott_hypotheses','pattern_detections','instrument_alignment',
      'swing_analysis_results','swing_analysis_rule_traces','provider_rate_limit_buckets'
    ]) as t(tablename)
    where not has_table_privilege('authenticated', 'public.' || t.tablename, 'SELECT')
  ),
  'authenticated retains SELECT on every hardened computed/pipeline table'
);

select ok(
  not exists (
    select 1 from unnest(array[
      'strategy_versions','rule_definitions','parameter_versions','instruments','index_memberships',
      'market_bars_raw','market_bars_adjusted','corporate_actions','data_quality_results',
      'derivative_contracts','derivative_snapshots','pipeline_audit_log',
      'screening_runs','instrument_run_results','rule_traces','rankings','coverage_reconciliation',
      'instrument_direction','screening_run_leases','pipeline_batches','instrument_direction_runs',
      'direction_pivots','elliott_hypotheses','pattern_detections','instrument_alignment',
      'swing_analysis_results','swing_analysis_rule_traces','provider_rate_limit_buckets'
    ]) as t(tablename)
    where has_table_privilege('authenticated', 'public.' || t.tablename, 'INSERT')
       or has_table_privilege('authenticated', 'public.' || t.tablename, 'UPDATE')
       or has_table_privilege('authenticated', 'public.' || t.tablename, 'DELETE')
  ),
  'authenticated has no write grant on any hardened computed/pipeline table (writes are service_role-only)'
);

select ok(
  has_table_privilege('authenticated', 'public.profiles', 'UPDATE'),
  'profiles keeps its authenticated UPDATE grant intentionally -- profiles_admin_update RLS gates the actual row access'
);

select * from finish();
rollback;

begin;

select plan(43);

-- Dedicated enrichment-owned tables exist (never the canonical rule_traces/
-- pattern_detections/analysis_bars/elliott_hypotheses).
select has_table('public', 'buy_setup_manifests');
select has_table('public', 'buy_setup_pipeline_batches');
select has_table('public', 'buy_setup_persistence_errors');
select has_table('public', 'buy_setup_gate_traces');
select has_table('public', 'buy_setup_candlestick_detections');
select has_table('public', 'buy_setup_chart_pattern_detections');
select has_table('public', 'buy_setup_pattern_detector_coverage');
select has_table('public', 'buy_setup_ema_crossover');
select has_table('public', 'buy_setup_chart_levels');
select has_table('public', 'buy_setup_fifteen_minute_bars');
select has_table('public', 'buy_setup_intraday_indicators');
select has_table('public', 'buy_setup_fifteen_minute_wave');
select has_table('public', 'buy_setup_divergence_evidence');
select has_table('public', 'buy_setup_charts');

-- Canonical tables were NOT widened/altered by this migration.
select isnt(
  (select true from information_schema.check_constraints where constraint_name = 'analysis_bars_interval_check' and check_clause like '%15m%'),
  true,
  'analysis_bars.interval was NOT widened to accept 15m -- canonical table left untouched'
);
select isnt(
  (select true from information_schema.check_constraints where constraint_name = 'elliott_hypotheses_timeframe_check' and check_clause like '%15m%'),
  true,
  'elliott_hypotheses.timeframe was NOT widened to accept 15m -- canonical table left untouched'
);

-- Parameter/rule-version provenance columns on the manifest.
select has_column('public', 'buy_setup_manifests', 'strategy_version_id');
select has_column('public', 'buy_setup_manifests', 'rule_version');
select has_column('public', 'buy_setup_manifests', 'parameter_version_id');
select has_column('public', 'buy_setup_manifests', 'parameter_version');
select has_column('public', 'buy_setup_manifests', 'enrichment_state');
select has_column('public', 'buy_setup_gate_traces', 'source_status');
select has_column('public', 'buy_setup_gate_traces', 'source_locator');

-- Durable batching primitives.
select has_function('public', 'claim_next_buy_setup_batch', ARRAY['uuid']);
select has_function('public', 'reset_stale_buy_setup_batches', ARRAY['uuid', 'int4', 'int4']);
select has_function('public', 'publish_buy_setup_enrichment', ARRAY['uuid']);

-- Pagination view exists.
select has_view('public', 'buy_setup_analysis_ledger');

-- RLS enabled on every new table.
select ok((select relrowsecurity from pg_class where oid = 'public.buy_setup_manifests'::regclass), 'buy_setup_manifests has RLS enabled');
select ok((select relrowsecurity from pg_class where oid = 'public.buy_setup_pipeline_batches'::regclass), 'buy_setup_pipeline_batches has RLS enabled');
select ok((select relrowsecurity from pg_class where oid = 'public.buy_setup_persistence_errors'::regclass), 'buy_setup_persistence_errors has RLS enabled');
select ok((select relrowsecurity from pg_class where oid = 'public.buy_setup_gate_traces'::regclass), 'buy_setup_gate_traces has RLS enabled');
select ok((select relrowsecurity from pg_class where oid = 'public.buy_setup_candlestick_detections'::regclass), 'buy_setup_candlestick_detections has RLS enabled');
select ok((select relrowsecurity from pg_class where oid = 'public.buy_setup_charts'::regclass), 'buy_setup_charts has RLS enabled');

-- Authenticated-select-only, no anon access, no authenticated writes.
select ok(
  not has_table_privilege('anon', 'public.buy_setup_manifests', 'SELECT')
  and has_table_privilege('authenticated', 'public.buy_setup_manifests', 'SELECT')
  and not has_table_privilege('authenticated', 'public.buy_setup_manifests', 'INSERT,UPDATE,DELETE'),
  'buy_setup_manifests is authenticated-read-only and inaccessible to anon'
);
select ok(
  not has_table_privilege('anon', 'public.buy_setup_gate_traces', 'SELECT')
  and has_table_privilege('authenticated', 'public.buy_setup_gate_traces', 'SELECT')
  and not has_table_privilege('authenticated', 'public.buy_setup_gate_traces', 'INSERT,UPDATE,DELETE'),
  'buy_setup_gate_traces is authenticated-read-only and inaccessible to anon'
);
select ok(
  not has_table_privilege('anon', 'public.buy_setup_pipeline_batches', 'SELECT')
  and has_table_privilege('authenticated', 'public.buy_setup_pipeline_batches', 'SELECT')
  and not has_table_privilege('authenticated', 'public.buy_setup_pipeline_batches', 'INSERT,UPDATE,DELETE'),
  'buy_setup_pipeline_batches is authenticated-read-only and inaccessible to anon'
);

-- A partial/failed enrichment must never be visible to a plain Viewer: every
-- child table's read policy is gated by buy_setup_manifests, not by
-- screening_runs.publication_state.
select ok(
  (select qual from pg_policies where schemaname = 'public' and tablename = 'buy_setup_gate_traces' and policyname = 'buy_setup_gate_traces_read') like '%buy_setup_manifests%',
  'buy_setup_gate_traces_read gates on the enrichment manifest, not the main run publication state'
);
select ok(
  (select qual from pg_policies where schemaname = 'public' and tablename = 'buy_setup_candlestick_detections' and policyname = 'buy_setup_candlestick_detections_read') like '%buy_setup_manifests%',
  'buy_setup_candlestick_detections_read gates on the enrichment manifest'
);
select ok(
  (select qual from pg_policies where schemaname = 'public' and tablename = 'buy_setup_intraday_indicators' and policyname = 'buy_setup_intraday_indicators_read') like '%buy_setup_manifests%',
  'buy_setup_intraday_indicators_read gates on the enrichment manifest'
);
select ok(
  (select qual from pg_policies where schemaname = 'public' and tablename = 'buy_setup_divergence_evidence' and policyname = 'buy_setup_divergence_evidence_read') like '%buy_setup_manifests%',
  'buy_setup_divergence_evidence_read gates on the enrichment manifest'
);
select ok(
  (select qual from pg_policies where schemaname = 'public' and tablename = 'buy_setup_chart_levels' and policyname = 'buy_setup_chart_levels_read') like '%buy_setup_manifests%',
  'buy_setup_chart_levels_read gates on the enrichment manifest'
);
select ok(
  (select qual from pg_policies where schemaname = 'public' and tablename = 'buy_setup_fifteen_minute_wave' and policyname = 'buy_setup_fifteen_minute_wave_read') like '%buy_setup_manifests%',
  'buy_setup_fifteen_minute_wave_read gates on the enrichment manifest'
);

-- Operational tables (batches, persistence errors) are Researcher+ only,
-- never gated by enrichment_state='published' -- a Viewer must never see
-- pipeline internals regardless of the enrichment's own state.
select ok(
  (select qual from pg_policies where schemaname = 'public' and tablename = 'buy_setup_pipeline_batches' and policyname = 'buy_setup_pipeline_batches_read') not like '%published%',
  'buy_setup_pipeline_batches_read is role-gated only, not publication-state-gated'
);

select * from finish();
rollback;

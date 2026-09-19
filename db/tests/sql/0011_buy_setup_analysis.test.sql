-- Originally authored for Supabase pgTAP; RLS / role-privilege assertions removed (see docs/gcp/schema-provenance.md).
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

select * from finish();
rollback;
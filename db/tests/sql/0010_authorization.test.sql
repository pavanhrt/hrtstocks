-- Originally authored for Supabase pgTAP; RLS / role-privilege assertions removed (see docs/gcp/schema-provenance.md).
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

select has_function('public', 'publish_screening_run', array['uuid']);
select has_function('public', 'expire_stale_screening_runs', array['timestamp with time zone']);

select * from finish();
rollback;
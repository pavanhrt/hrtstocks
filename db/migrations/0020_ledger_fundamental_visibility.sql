-- Adds fundamental_result_published to buy_setup_analysis_ledger (see comment in the view).

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
  max(fsr.score_version) as fundamental_score_version,
  -- Added for Cloud SQL: RLS used to hide results from unpublished refresh
  -- manifests from non-staff readers. The app now masks the fundamental_*
  -- columns for viewers unless this is true (app/src/lib/data/buy-setup-analysis.ts).
  coalesce(bool_or(frm.refresh_state = 'published'), false) as fundamental_result_published
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
left join fundamental_refresh_manifests frm on frm.id = fsr.refresh_manifest_id
where not irr.is_index
group by irr.run_id, irr.instrument_id, i.symbol, i.name;

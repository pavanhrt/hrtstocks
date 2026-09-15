// Universe screening has no trade-entry or portfolio context -- no
// entry/stop/target/capital/monthly-loss figures exist yet, only
// OHLCV-derived indicators. SMM's decision-stage (SMM-RISK-001/002,
// SMM-RR-001) and portfolio-stage (SMM-SIZE-001, SMM-MONTHLY-001) hard gates
// depend on exactly those inputs, so at screening time they always resolve
// to their own missing_result rather than a real PASS/FAIL -- evaluating
// them here only adds noise (and, before the FAIL-only fix in
// rules/evaluate.js, silently rejected every instrument in the universe,
// since a hard gate's missing_result used to count as a rejection too).
// Trade-entry validation for a specific route's own entry/stop/target
// belongs to the swing-analysis path (features/reward-risk.js,
// features/swing-vetoes.js), not screening.
const SCREENING_EXCLUDED_TIMEFRAMES = new Set(["decision", "portfolio", "portfolio_month"]);

// BSA (strategies/buy-setup-analysis.yaml, PROJECT_DEFAULT/user-requested --
// see that file's decision record) is evaluated ONLY inside
// supabase/functions/analyze-buy-setup, never during ordinary universe
// screening. Its inputs (bsa_daily_dow_state,
// bsa_daily_range_breakout_up_with_volume, and the monthly/weekly
// passthrough fields buildThreeTimeframeContext assembles) are never present
// in run-screening's own feature context, so if BSA-G1 were left in the
// screening rule set it would always resolve to NO_DATA there today -- but
// that is an accident of what the two contexts happen not to share, not a
// structural guarantee, and BSA-G1 is a hard_gate:true rule
// (strategies/buy-setup-analysis.yaml's own note explains why: it is this
// page's own dedicated qualification gate, not pooled against
// SMM/PAPA/GUE/FOME). A hard gate that spuriously resolves to FAIL or PASS
// here -- e.g. once a future run-screening context change coincidentally
// starts populating a same-named field -- would silently reject or pass
// every instrument in the whole screening universe for a reason that has
// nothing to do with SMM/PAPA/GUE/FOME. Excluded by framework, not by
// timeframe, since BSA-G1's own timeframe is "combined" (not one of the
// decision/portfolio values above) and BSA-D1's is "daily" (indistinguishable
// by timeframe alone from every other daily SMM/PAPA/GUE rule).
const SCREENING_EXCLUDED_FRAMEWORKS = new Set(["BSA"]);

/**
 * Filters a run's full rule_definitions set down to the subset appropriate
 * for universe-screening evaluation (rules/evaluate.js's evaluateRules).
 *
 * @param {{ timeframe: string|null, framework?: string|null }[]} ruleDefinitions
 */
export function filterScreeningRules(ruleDefinitions) {
  return (ruleDefinitions ?? []).filter(
    (r) => !SCREENING_EXCLUDED_TIMEFRAMES.has(r.timeframe) && !SCREENING_EXCLUDED_FRAMEWORKS.has(r.framework)
  );
}

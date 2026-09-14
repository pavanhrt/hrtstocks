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

/**
 * Filters a run's full rule_definitions set down to the subset appropriate
 * for universe-screening evaluation (rules/evaluate.js's evaluateRules).
 *
 * @param {{ timeframe: string|null }[]} ruleDefinitions
 */
export function filterScreeningRules(ruleDefinitions) {
  return (ruleDefinitions ?? []).filter((r) => !SCREENING_EXCLUDED_TIMEFRAMES.has(r.timeframe));
}

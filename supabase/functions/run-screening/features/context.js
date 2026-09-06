import { ema } from "./indicators.js";

/**
 * Builds the feature context an instrument's rules are evaluated against.
 *
 * Deliberately narrow for Phase 1: `config/parameters.yaml` marks RSI period,
 * ADX/DMI period, Bollinger lookback/deviation, volume lookback/multiplier,
 * and pivot left/right windows as `project_defaults_requiring_backtest`
 * (currently `null`). Computing trend-structure (higher-high/low), Tide/Wave
 * oscillator state, volume confirmation, support/resistance, or Bollinger
 * band state would require silently choosing an undocumented window for one
 * of those -- exactly what AGENTS.md's CRITICAL rules forbid ("Never invent,
 * interpolate... Never silently change a documented strategy condition").
 *
 * So this only computes what config/parameters.yaml's `documented` section
 * fully specifies (the EMA periods). Every other identifier referenced by
 * strategies/*.yaml is left absent, which the rule engine already handles
 * correctly: missing inputs resolve to each rule's own `missing_result`
 * (NO_DATA or MANUAL_REVIEW, as documented) rather than a fabricated pass.
 * Extend this function only when a parameter it depends on has moved from
 * `project_defaults_requiring_backtest` to `documented`.
 *
 * @param {import("../providers/types.js").Bar[]} bars - oldest-first
 * @param {{ ema_periods: number[] }} documentedParams
 */
export function buildFeatureContext(bars, documentedParams) {
  const closes = bars.map((b) => b.close);
  const context = {};

  for (const period of documentedParams.ema_periods ?? []) {
    context[`ema_${period}`] = ema(closes, period);
  }

  context.close = closes.length > 0 ? closes[closes.length - 1] : null;

  return context;
}

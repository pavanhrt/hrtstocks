import { ema, bollingerBands, rsiWithPrevious, stochastic, macdHistogramPhase, averageVolume } from "./indicators.js";
import { aggregateBars, zigzagPivots, classifyDowStructure, rangeBreakoutWithVolume } from "./structure.js";

/**
 * Builds the feature context an instrument's rules are evaluated against.
 *
 * Originally this only computed the documented EMA periods off the daily
 * bars, because config/parameters.yaml left RSI/Stochastic/Bollinger/volume
 * periods as `project_defaults_requiring_backtest` (null). parameter_version
 * 1.1.0 resolved those from the BUY/SELL Signal Playbooks' own Stage 0 data
 * tables, so this now also computes:
 *
 *   - Unprefixed daily indicators (`rsi`, `average_volume`,
 *     `bollinger_upper_3sd`, `bollinger_lower_3sd`) for the existing SMM/
 *     PAPA/GUE/FOME rules in strategies/*.yaml that already reference them.
 *   - `daily_*` / `weekly_*` / `monthly_*` namespaced indicators (Dow
 *     structure, MACD histogram phase, Stochastic, RSI) for
 *     strategies/buy-signal-playbook.yaml and sell-signal-playbook.yaml,
 *     which need to reason about more than one timeframe at once.
 *
 * ADX/DMI, ATR and the pivot-left/right-window parameters are still null
 * (project_defaults_requiring_backtest) and are deliberately left
 * uncomputed here -- no seeded rule needs them yet, and the null_policy
 * forbids resolving a parameter before something depends on the resolved
 * value.
 *
 * @param {import("../providers/types.js").Bar[]} bars - oldest-first, daily
 * @param {object} documentedParams - config/parameters.yaml's `documented` section
 */
export function buildFeatureContext(bars, documentedParams) {
  const closes = bars.map((b) => b.close);
  const highs = bars.map((b) => b.high);
  const lows = bars.map((b) => b.low);
  const context = {};

  for (const period of documentedParams.ema_periods ?? []) {
    context[`ema_${period}`] = ema(closes, period);
  }
  context.close = closes.length > 0 ? closes[closes.length - 1] : null;

  const rsiPeriod = documentedParams.rsi_period;
  if (rsiPeriod != null) {
    const { value, previous } = rsiWithPrevious(closes, rsiPeriod);
    context.rsi = value;
    context.daily_rsi = value;
    context.daily_rsi_previous = previous;
  }

  const volumeLookback = documentedParams.volume_lookback;
  const volumeMultiplier = documentedParams.volume_multiplier;
  if (volumeLookback != null) {
    context.average_volume = averageVolume(
      bars.map((b) => b.volume),
      volumeLookback
    );
  }

  const bollingerLookback = documentedParams.bollinger_lookback;
  if (bollingerLookback != null && documentedParams.papa_extreme_bollinger_deviation != null) {
    const extreme = bollingerBands(closes, bollingerLookback, documentedParams.papa_extreme_bollinger_deviation);
    context.bollinger_upper_3sd = extreme.upper;
    context.bollinger_lower_3sd = extreme.lower;
  }

  const stochasticLookback = documentedParams.stochastic_lookback;
  const stochasticSmoothing = documentedParams.stochastic_smoothing;
  if (stochasticLookback != null && stochasticSmoothing != null) {
    const { k, d, kPrevious, dPrevious } = stochastic(
      highs,
      lows,
      closes,
      stochasticLookback,
      stochasticSmoothing,
      stochasticSmoothing
    );
    context.daily_stochastic_k = k;
    context.daily_stochastic_d = d;
    context.daily_stochastic_k_previous = kPrevious;
    context.daily_stochastic_d_previous = dPrevious;
  }

  const macdFast = documentedParams.macd_fast;
  const macdSlow = documentedParams.macd_slow;
  const macdSignal = documentedParams.macd_signal;

  if (documentedParams.zigzag_weekly_pct != null) {
    applyTimeframe(context, "weekly", aggregateBars(bars, "weekly"), {
      zigzagPct: documentedParams.zigzag_weekly_pct,
      volumeLookback,
      volumeMultiplier,
      macdFast,
      macdSlow,
      macdSignal,
    });
  }
  if (documentedParams.zigzag_monthly_pct != null) {
    applyTimeframe(context, "monthly", aggregateBars(bars, "monthly"), {
      zigzagPct: documentedParams.zigzag_monthly_pct,
      volumeLookback,
      volumeMultiplier,
      macdFast,
      macdSlow,
      macdSignal,
    });
  }

  return context;
}

function applyTimeframe(context, label, timeframeBars, { zigzagPct, volumeLookback, volumeMultiplier, macdFast, macdSlow, macdSignal }) {
  if (timeframeBars.length < 2) return;
  const timeframeCloses = timeframeBars.map((b) => b.close);
  const lastClose = timeframeCloses[timeframeCloses.length - 1];

  const pivots = zigzagPivots(timeframeBars, zigzagPct);
  const structure = classifyDowStructure(pivots, lastClose);
  context[`${label}_dow_state`] = structure.state;

  if (volumeLookback != null && volumeMultiplier != null) {
    const breakout = rangeBreakoutWithVolume(structure, timeframeBars, volumeLookback, volumeMultiplier);
    context[`${label}_range_breakout_up_with_volume`] = breakout.up;
    context[`${label}_range_breakout_down_with_volume`] = breakout.down;
  }

  if (macdFast != null && macdSlow != null && macdSignal != null) {
    const { change, priorPhase } = macdHistogramPhase(timeframeCloses, macdFast, macdSlow, macdSignal, 4);
    context[`${label}_macd_histogram_change`] = change;
    context[`${label}_macd_histogram_prior_phase`] = priorPhase;
  }
}

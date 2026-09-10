import { ema, bollingerBands, rsiWithPrevious, stochastic, macdHistogramPhase, averageVolume } from "./indicators.js";
import { aggregateBars, zigzagPivots, zigzagPivotsWithUnconfirmedLeg, classifyDowStructure, rangeBreakoutWithVolume, labelPivotSequence } from "./structure.js";
import { labelWave } from "./wave.js";
import { detectCandlestickPatterns, detectDoubleExtremePatterns } from "./patterns.js";

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
 *   - `daily_dow_state` (previously only weekly/monthly were classified here
 *     -- direction.js separately computed a daily dow_state for the
 *     Direction feature, but nothing fed it into rule evaluation), plus
 *     `{weekly,daily}_elliott_*` (structure_type/direction/current_wave/
 *     wave_state/confidence, reusing structure.js's labelPivotSequence +
 *     wave.js's labelWave -- the same Elliott engine the Direction feature
 *     uses, not a separate approximation) and `daily_no_live_triggered_
 *     {bullish,bearish}_pattern` (reusing features/patterns.js's detectors)
 *     for strategies/buy-swing.yaml and sell-swing.yaml (WBP-/WSP- gates
 *     M1-M4/S1-S4, the weekly+daily direction lock ahead of the hourly
 *     chart -- see swing-strategy-extraction.md §4).
 *
 * ADX/DMI, ATR and the pivot-left/right-window parameters are still null
 * (project_defaults_requiring_backtest) and are deliberately left
 * uncomputed here -- no seeded rule needs them yet (DMI/ADX is needed by the
 * swing playbooks' hourly-side gates, M5-M8/S5-S8, which this codebase
 * cannot evaluate yet -- no 1-hour bars are ingested), and the null_policy
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
      withElliott: true,
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
  // Daily was previously only classified for the Direction feature
  // (direction.js, its own pipeline) -- WBP-M3/M4 and WSP-S3/S4 (the swing
  // playbook's daily-timeframe gates) need daily_dow_state and daily Elliott
  // position in THIS context too, so it's computed here with the same
  // zigzagPct/classifyDowStructure/labelWave this file already uses for
  // weekly/monthly (not a separate approximation).
  if (documentedParams.zigzag_daily_pct != null) {
    applyTimeframe(context, "daily", bars, {
      zigzagPct: documentedParams.zigzag_daily_pct,
      volumeLookback,
      volumeMultiplier,
      macdFast,
      macdSlow,
      macdSignal,
      withElliott: true,
    });

    // WBP-M3/WSP-S3's "no live triggered [opposing] daily pattern" clause --
    // reuses features/patterns.js's detectors directly on daily bars (the
    // same detectors index.js persists into pattern_detections; recomputing
    // here keeps this module self-contained -- bars+params in, context out --
    // rather than threading pattern_detections rows through the call chain).
    const dailyPatternHits = [...detectCandlestickPatterns(bars), ...detectDoubleExtremePatterns(zigzagPivots(bars, documentedParams.zigzag_daily_pct), bars)];
    context.daily_no_live_triggered_bearish_pattern = !dailyPatternHits.some((h) => h.state === "TRIGGERED" && h.direction === "bearish");
    context.daily_no_live_triggered_bullish_pattern = !dailyPatternHits.some((h) => h.state === "TRIGGERED" && h.direction === "bullish");
  }

  return context;
}

function applyTimeframe(context, label, timeframeBars, { zigzagPct, volumeLookback, volumeMultiplier, macdFast, macdSlow, macdSignal, withElliott = false }) {
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

  if (withElliott) {
    // Same Elliott engine the Direction feature uses (structure.js's
    // labelPivotSequence + wave.js's labelWave), not a separate
    // approximation -- WBP-M2/M4 and WSP-S2/S4 need to know the current
    // wave position, not just the Dow trend direction.
    const { confirmed: rawPivots, unconfirmedLeg } = zigzagPivotsWithUnconfirmedLeg(timeframeBars, zigzagPct);
    const labeledPivots = labelPivotSequence(rawPivots);
    const { primary: wave } = labelWave(labeledPivots, unconfirmedLeg, structure.state);
    context[`${label}_elliott_structure_type`] = wave.structureType;
    context[`${label}_elliott_direction`] = wave.direction;
    context[`${label}_elliott_current_wave`] = wave.currentWave;
    context[`${label}_elliott_wave_state`] = wave.waveState;
    context[`${label}_elliott_confidence`] = wave.confidence;
  }

  if (macdFast != null && macdSlow != null && macdSignal != null) {
    const { change, priorPhase } = macdHistogramPhase(timeframeCloses, macdFast, macdSlow, macdSignal, 4);
    context[`${label}_macd_histogram_change`] = change;
    context[`${label}_macd_histogram_prior_phase`] = priorPhase;
  }
}

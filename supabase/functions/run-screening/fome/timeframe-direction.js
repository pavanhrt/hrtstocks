// Multi-timeframe direction rows and final alignment for the single-instrument
// FOME analysis page. Pure functions over already-fetched bar arrays -- no
// I/O, reuses the SAME indicator/structure primitives every other strategy in
// this codebase uses (features/indicators.js, features/structure.js), rather
// than a separate approximation. Unlike this repo's own buy-setup module
// (three-timeframe-gate.js), which reads Monthly/Weekly from already-published
// rule_traces, FOME computes all four timeframes itself -- there is no
// existing FOME-scoped evidence to read, and FOME's own instrument may never
// have been screened by the full-universe pipeline at all.
//
// Timeframe-responsibility mapping is a disclosed, versioned PROJECT_DEFAULT
// (FOME's own source documents never state this exact division):
//   Monthly  -> primary regime and long-term direction
//   Weekly   -> trend confirmation
//   Daily    -> actionable setup, support/resistance, target, invalidation
//   15-minute -> lower-timeframe entry timing and immediate confirmation only
//                (never allowed to reverse a Monthly/Weekly conclusion)

import { rsi, adx, adxSlope, macdSlope, bollingerBands } from "../features/indicators.js";
import { zigzagPivots, classifyDowStructure, labelPivotSequence, rangeBreakoutWithVolume } from "../features/structure.js";

export const FOME_TIMEFRAME_RESPONSIBILITY_VERSION = "1.0.0";
export const FOME_ALIGNMENT_LOGIC_VERSION = "1.0.0";

// zigzag_fifteen_minute_pct (config/parameters.yaml, already documented and
// versioned for this repo's OWN buy-setup 15-minute Elliott-wave module,
// features/wave.js via buy-setup/fifteen-minute-wave.js) -- reused here
// verbatim rather than inventing a second, uncoordinated 15-minute
// threshold. Unlike a from-scratch project, this repo already resolved this
// exact question; FOME does not need its own answer.
const ZIGZAG_PCT_BY_TIMEFRAME = {
  monthly: "zigzag_monthly_pct",
  weekly: "zigzag_weekly_pct",
  daily: "zigzag_daily_pct",
  "15m": "zigzag_fifteen_minute_pct",
};

function directionFromDowState(state) {
  if (state === "uptrend_intact" || state === "confirmed_reversal_bullish") return "bullish";
  if (state === "downtrend_intact" || state === "confirmed_reversal_bearish") return "bearish";
  if (state === "sideways") return "sideways";
  return null; // ambiguous / insufficient pivots -- never guessed
}

function bollingerState(closes, lookback, deviations, lookbackBars = 10) {
  if (closes.length < lookback + lookbackBars) return { state: null, priceLocation: null };
  const widths = [];
  for (let i = closes.length - lookbackBars; i < closes.length; i++) {
    const slice = closes.slice(0, i + 1);
    const bands = bollingerBands(slice, lookback, deviations);
    if (bands.upper == null || bands.lower == null) continue;
    widths.push(bands.upper - bands.lower);
  }
  if (widths.length < 2) return { state: null, priceLocation: null };

  const latestBands = bollingerBands(closes, lookback, deviations);
  const lastClose = closes[closes.length - 1];
  let priceLocation = null;
  if (latestBands.upper != null && latestBands.lower != null) {
    if (lastClose >= latestBands.upper) priceLocation = "at_or_above_upper_band";
    else if (lastClose <= latestBands.lower) priceLocation = "at_or_below_lower_band";
    else priceLocation = "inside_bands";
  }

  const first = widths[0];
  const last = widths[widths.length - 1];
  const changeFraction = first > 0 ? (last - first) / first : 0;
  let state;
  if (changeFraction > 0.1) state = "expanding";
  else if (changeFraction < -0.1) state = "contracting";
  else state = "flat";
  // BKP ("Bollinger breakout, price side")/BKT ("Bollinger breakout, trend
  // side") are named in strategies/fome.md/.yaml but have no validated
  // deterministic definition anywhere in this project's source register --
  // this function deliberately never emits those two labels; they remain
  // UNRESOLVED/MANUAL_REVIEW at the rule-evaluation layer (see
  // strategies/fome-single-instrument.yaml).
  return { state, priceLocation };
}

/**
 * Builds one Direction-table row for one timeframe.
 * @param {"monthly"|"weekly"|"daily"|"15m"} timeframe
 * @param {import("../providers/types.js").Bar[]} bars oldest-first, already the correct timeframe (aggregated or fetched)
 * @param {object} documentedParams config/parameters.yaml `documented`
 * @param {{isProvisional?: boolean, freshness?: string}} [meta]
 */
export function buildFomeTimeframeRow(timeframe, bars, documentedParams, meta = {}) {
  const base = {
    timeframe,
    latestCompletedCandle: null,
    freshness: meta.freshness ?? null,
    isProvisional: Boolean(meta.isProvisional),
    dowState: null,
    pivotSequence: null,
    macdState: null,
    rsi: null,
    adx: null,
    adxSlope: null,
    bollingerState: null,
    bollingerPriceLocation: null,
    support: null,
    resistance: null,
    breakoutState: null,
    direction: null,
    confidence: "unavailable",
    explanation: "",
  };

  if (!bars || bars.length === 0) {
    base.confidence = "unavailable";
    base.explanation = `No ${timeframe} bars are available for this instrument.`;
    return base;
  }

  const lastBar = bars[bars.length - 1];
  base.latestCompletedCandle = meta.isProvisional ? null : (lastBar.date ?? lastBar.ts ?? null);

  const closes = bars.map((b) => b.close);
  const highs = bars.map((b) => b.high);
  const lows = bars.map((b) => b.low);

  const macdFast = documentedParams.macd_fast;
  const macdSlow = documentedParams.macd_slow;
  const macdSignal = documentedParams.macd_signal;
  if (macdFast != null && macdSlow != null && macdSignal != null) {
    base.macdState = macdSlope(closes, macdFast, macdSlow, macdSignal);
  }

  if (documentedParams.rsi_period != null) {
    base.rsi = rsi(closes, documentedParams.rsi_period);
  }

  if (documentedParams.adx_dmi_period != null) {
    const { adx: adxValue } = adx(highs, lows, closes, documentedParams.adx_dmi_period);
    base.adx = adxValue;
    base.adxSlope = adxSlope(highs, lows, closes, documentedParams.adx_dmi_period);
  }

  if (documentedParams.bollinger_lookback != null && documentedParams.standard_bollinger_deviation != null) {
    const { state, priceLocation } = bollingerState(closes, documentedParams.bollinger_lookback, documentedParams.standard_bollinger_deviation);
    base.bollingerState = state;
    base.bollingerPriceLocation = priceLocation;
  }

  const zigzagParamKey = ZIGZAG_PCT_BY_TIMEFRAME[timeframe];
  const zigzagPct = zigzagParamKey ? documentedParams[zigzagParamKey] : null;
  if (zigzagPct != null) {
    const pivots = zigzagPivots(bars, zigzagPct);
    const structure = classifyDowStructure(pivots, closes[closes.length - 1]);
    base.dowState = structure.state;
    base.support = structure.lastSwingLow;
    base.resistance = structure.lastSwingHigh;
    base.pivotSequence = labelPivotSequence(pivots).slice(-6).map((p) => p.type);
    base.direction = directionFromDowState(structure.state);

    if (documentedParams.volume_lookback != null && documentedParams.volume_multiplier != null) {
      const breakout = rangeBreakoutWithVolume(structure, bars, documentedParams.volume_lookback, documentedParams.volume_multiplier);
      base.breakoutState = breakout.up ? "breakout_up_confirmed" : breakout.down ? "breakdown_confirmed" : "none";
    }

    base.confidence = base.direction ? "confirmed" : structure.state === "ambiguous" ? "manual_review" : "unavailable";
  } else {
    // No zigzag threshold resolved for this timeframe -- never invents one
    // (null_policy). Direction falls back to momentum only.
    base.direction = base.macdState === "rising" ? "bullish" : base.macdState === "falling" ? "bearish" : "sideways";
    base.confidence = meta.isProvisional ? "provisional" : "confirmed";
  }

  base.explanation = describeTimeframe(timeframe, base);
  return base;
}

function describeTimeframe(timeframe, row) {
  const parts = [];
  if (row.dowState) parts.push(`Dow structure: ${row.dowState.replace(/_/g, " ")}`);
  if (row.macdState) parts.push(`MACD ${row.macdState}`);
  if (row.rsi != null) parts.push(`RSI ${row.rsi.toFixed(1)}`);
  if (row.adx != null) parts.push(`ADX ${row.adx.toFixed(1)} (${row.adxSlope ?? "unknown slope"})`);
  if (row.bollingerState) parts.push(`Bollinger ${row.bollingerState}`);
  if (row.breakoutState && row.breakoutState !== "none") parts.push(row.breakoutState.replace(/_/g, " "));
  if (row.isProvisional) parts.push("latest candle is still forming (provisional)");
  return parts.length > 0 ? `${timeframe}: ${parts.join("; ")}.` : `${timeframe}: insufficient data to describe structure.`;
}

/**
 * Deterministic, non-cryptographic change-detector for the Monthly/Weekly
 * cache-reuse policy: "reuse only when still current, complete, and
 * calculated with the same algorithm/parameter/adjustment versions... the
 * cached input hash no longer matches." Keys off the LAST FEW aggregated
 * bars (not just the latest one) plus the total bar count -- a
 * newly-completed week/month changes the count, and any newly-arrived daily
 * bar that revises the still-forming current period's high/low/close changes
 * the last bar's own values, so either case changes the hash without a
 * separate calendar check. A version-string change alone also changes the
 * hash even if the bars are identical.
 * @param {object} params
 * @param {import("../providers/types.js").Bar[]} params.timeframeBars oldest-first
 * @param {string} params.algorithmVersion
 * @param {string} params.parameterVersion
 * @param {string} params.adjustmentVersion
 * @returns {string}
 */
export function computeFomeTimeframeInputHash({ timeframeBars, algorithmVersion, parameterVersion, adjustmentVersion }) {
  const material = JSON.stringify({
    lastBars: timeframeBars.slice(-3).map((b) => [b.date, b.open, b.high, b.low, b.close]),
    count: timeframeBars.length,
    algorithmVersion,
    parameterVersion,
    adjustmentVersion,
  });
  let hash = 0;
  for (let i = 0; i < material.length; i++) {
    hash = (hash * 31 + material.charCodeAt(i)) | 0;
  }
  return String(hash >>> 0);
}

/**
 * Final FOME alignment across the four timeframes -- a disclosed, versioned
 * PROJECT_DEFAULT synthesis (FOME_ALIGNMENT_LOGIC_VERSION): Monthly is the
 * primary regime; Weekly must agree with Monthly for a directional call
 * (disagreement -> MIXED); Daily supplies the actionable setup and can also
 * downgrade to MIXED if it actively opposes the Monthly+Weekly consensus;
 * 15-minute can only gate entry timing (WAIT_FOR_ENTRY_CONFIRMATION when
 * opposed), never reverse the higher-timeframe conclusion. Missing
 * Monthly/Weekly data always yields UNAVAILABLE.
 * @param {{monthly: object, weekly: object, daily: object, fifteenMin: object}} rows
 */
export function computeFomeAlignment({ monthly, weekly, daily, fifteenMin }) {
  if (!monthly || monthly.confidence === "unavailable" || !weekly || weekly.confidence === "unavailable") {
    return {
      finalAlignment: "UNAVAILABLE",
      reason: "Monthly and/or Weekly data is unavailable -- a primary regime call requires both.",
    };
  }

  if (monthly.confidence === "manual_review" || weekly.confidence === "manual_review") {
    return {
      finalAlignment: "MANUAL_REVIEW",
      reason: "Monthly and/or Weekly structure is ambiguous (HH+LL expansion or insufficient pivots) and requires human review.",
    };
  }

  const monthlyDir = monthly.direction;
  const weeklyDir = weekly.direction;

  if (monthlyDir === "sideways" && weeklyDir === "sideways") {
    const expanding = monthly.bollingerState === "expanding" || weekly.bollingerState === "expanding";
    return {
      finalAlignment: expanding ? "VOLATILITY_EXPANSION" : "SIDEWAYS",
      reason: expanding
        ? "Monthly and Weekly are both range-bound but Bollinger bandwidth is expanding -- a breakout regime may be starting."
        : "Monthly and Weekly both show a sideways/range-bound structure.",
    };
  }

  if (!monthlyDir || !weeklyDir || monthlyDir !== weeklyDir) {
    return {
      finalAlignment: "MIXED",
      reason: `Monthly (${monthlyDir ?? "unavailable"}) and Weekly (${weeklyDir ?? "unavailable"}) do not agree -- no directional call is made from conflicting higher timeframes.`,
    };
  }

  const higherTimeframeDirection = monthlyDir;

  if (daily && daily.direction && daily.direction !== "sideways" && daily.direction !== higherTimeframeDirection) {
    return {
      finalAlignment: "MIXED",
      reason: `Daily structure (${daily.direction}) opposes the Monthly/Weekly ${higherTimeframeDirection} consensus.`,
    };
  }

  const aligned = higherTimeframeDirection === "bullish" ? "ALIGNED_BULLISH" : "ALIGNED_BEARISH";

  if (fifteenMin && fifteenMin.direction && fifteenMin.direction !== "sideways" && fifteenMin.direction !== higherTimeframeDirection) {
    return {
      finalAlignment: "WAIT_FOR_ENTRY_CONFIRMATION",
      reason: `Monthly/Weekly/Daily are ${higherTimeframeDirection}, but the 15-minute timeframe is currently opposed -- per FOME's timeframe responsibility, 15-minute evidence cannot reverse a higher-timeframe conclusion, only defer entry.`,
      underlyingAlignment: aligned,
    };
  }

  return {
    finalAlignment: aligned,
    reason: `Monthly, Weekly${daily?.direction ? ", and Daily" : ""} all agree on a ${higherTimeframeDirection} structure${fifteenMin?.direction === higherTimeframeDirection ? ", confirmed by 15-minute entry timing" : ""}.`,
  };
}

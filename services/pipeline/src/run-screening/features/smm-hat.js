// SMM Bull/Bear Hat -- Gate M7/S7 (BUY_Signal_Playbook_Weekly_Daily_1H.md §6
// "Stage 5 -- Gate M7. The SMM Decision Sheet" / SELL...§8,
// smm-decision-sheet-SKILL.md §1-§3). WBP-M7/WSP-S7's own timeframe is "1h"
// (strategies/buy-swing.yaml), so every check below is evaluated against the
// 1-hour chart -- matching the source table's own hourly wording ("Volume...
// above its hour-slot average").
//
// Step 1 (the Tide, daily): reuses the SAME daily MACD histogram phase
// already computed for WBP-M4/WSP-S4 (features/indicators.js's
// macdHistogramPhase) plus the daily Dow-structure state
// (features/structure.js's classifyDowStructure, computed by the caller --
// this module takes the result, not the raw bars, to avoid recomputing it a
// second time) for the required "visual Dow confirmation."
//
// Step 2 (the Wave, 1-hour): the source only says "name the actual
// crossover" without fixing which one (swing-strategy-extraction.md §13
// conflict #11). This reuses, unchanged, the exact disclosed choice this
// project already made for the positional strategy's daily BSP-M7B/SSP-S7B
// gates (strategies/buy-signal-playbook.yaml / sell-signal-playbook.yaml):
// a Stochastic %K/%D bullish[bearish] crossover from below 20[above 80], OR
// an RSI uptick[downtick] through the 40[60] line -- applied here to the
// 1-hour chart instead of daily. A disclosed re-application of an existing
// project decision, not a new one (conflict #11's own "not confirmed as the
// right choice for the 1-hour variant" note is resolved by this reuse).
//
// Hat = BUY only when Step 1 AND Step 2 both read BUY (mirrored for SELL);
// any disagreement is "no hat and no trade" -- the source's own designed
// output, not a failure to reach one.
//
// Checks 1-4 ("the evidence") reuse existing hourly detectors; checks 5-6
// ("quality filters") are graded, never gating, per the source's own framing
// ("they grade the setup; they do not create a signal").

import { hourSlotAverageVolume, emaSeries, rsiWithPrevious, stochastic } from "./indicators.js";
import { detectCandlestickPatterns } from "./patterns.js";

const SMM_HAT_LOCATOR = "BUY_Signal_Playbook_Weekly_Daily_1H.md §6 / SELL...§8 (smm-decision-sheet-SKILL.md §1-§3)";

/**
 * Step 1 -- the Tide. Reuses the same daily MACD histogram phase reading
 * WBP-M4/WSP-S4 already compute, plus the daily Dow state for the required
 * visual confirmation.
 * @param {{change: string|null, priorPhase: string|null}} macdHistogramPhaseResult features/indicators.js#macdHistogramPhase(dailyCloses, 12, 26, 9)
 * @param {string} dailyDowState features/structure.js#classifyDowStructure(...).state
 * @param {boolean} bullish
 */
function evaluateStep1Tide(macdHistogramPhaseResult, dailyDowState, bullish) {
  const { change, priorPhase } = macdHistogramPhaseResult;
  if (change == null) return { reading: null, macdChange: null, macdPriorPhase: null, dowState: dailyDowState };
  const macdSupportsDirection = bullish
    ? change === "uptick" || (change === "flat" && priorPhase === "down")
    : change === "downtick" || (change === "flat" && priorPhase === "up");
  const dowSupportsDirection = bullish
    ? dailyDowState === "uptrend_intact" || dailyDowState === "confirmed_reversal_bullish"
    : dailyDowState === "downtrend_intact" || dailyDowState === "confirmed_reversal_bearish";
  const reading = macdSupportsDirection && dowSupportsDirection ? (bullish ? "BUY" : "SELL") : null;
  return { reading, macdChange: change, macdPriorPhase: priorPhase, dowState: dailyDowState };
}

/**
 * Step 2 -- the Wave, on the 1-hour chart. Same disclosed crossover choice
 * as BSP-M7B/SSP-S7B, reapplied to hourly closes/highs/lows.
 */
function evaluateStep2Wave(hourlyHighs, hourlyLows, hourlyCloses, bullish) {
  const { k, kPrevious, d, dPrevious } = stochastic(hourlyHighs, hourlyLows, hourlyCloses, 14, 3, 3);
  const { value: rsiValue, previous: rsiPrevious } = rsiWithPrevious(hourlyCloses, 14);
  if (k == null || rsiValue == null) return { reading: null, stochastic: { k, d, kPrevious, dPrevious }, rsi: { value: rsiValue, previous: rsiPrevious } };

  const stochasticCrossover = bullish
    ? k > d && kPrevious <= dPrevious && kPrevious < 20
    : k < d && kPrevious >= dPrevious && kPrevious > 80;
  const rsiCrossover = bullish ? rsiValue >= 40 && rsiPrevious < 40 : rsiValue <= 60 && rsiPrevious > 60;
  const reading = stochasticCrossover || rsiCrossover ? (bullish ? "BUY" : "SELL") : null;
  return { reading, stochasticCrossover, rsiCrossover, stochastic: { k, d, kPrevious, dPrevious }, rsi: { value: rsiValue, previous: rsiPrevious } };
}

/**
 * Check 3 -- EMA 5 PCO[NCO] with 13 or 26 within the last 3 candles. Skipped
 * (returns null) when the signal is a morning/evening star or a double
 * bottom/top per the source's own two documented exceptions ("those
 * patterns turn faster than the EMAs, so the crossover would arrive far too
 * late").
 */
function evaluateEmaCrossoverCheck(closes, bullish, skip) {
  if (skip) return null;
  const fast = emaSeries(closes, 5);
  const slow13 = emaSeries(closes, 13);
  const slow26 = emaSeries(closes, 26);
  const lookback = Math.min(3, closes.length - 1);
  for (let i = closes.length - lookback; i < closes.length; i++) {
    if (i < 1) continue;
    for (const slow of [slow13, slow26]) {
      if (slow[i - 1] == null || slow[i] == null || fast[i - 1] == null || fast[i] == null) continue;
      const crossedUp = fast[i - 1] <= slow[i - 1] && fast[i] > slow[i];
      const crossedDown = fast[i - 1] >= slow[i - 1] && fast[i] < slow[i];
      if (bullish && crossedUp) return true;
      if (!bullish && crossedDown) return true;
    }
  }
  return false;
}

/**
 * Evaluates the full SMM Bull/Bear Hat -- Step 1, Step 2, the resulting hat,
 * and checks 1-4 (evidence, non-gating) / 5-6 (quality, non-gating).
 * @param {object} params
 * @param {{change: string|null, priorPhase: string|null}} params.dailyMacdHistogramPhase
 * @param {string} params.dailyDowState
 * @param {object[]} params.hourlyBars oldest-first, nse-calendar.js's normalizeHourlyBars() shape
 * @param {number} params.hourSlotVolumeLookbackSessions
 * @param {boolean} params.bullish
 * @returns {object}
 */
export function evaluateSmmHat({ dailyMacdHistogramPhase, dailyDowState, hourlyBars, hourSlotVolumeLookbackSessions, bullish }) {
  const step1 = evaluateStep1Tide(dailyMacdHistogramPhase, dailyDowState, bullish);
  const closes = hourlyBars.map((b) => b.close);
  const highs = hourlyBars.map((b) => b.high);
  const lows = hourlyBars.map((b) => b.low);
  const step2 = evaluateStep2Wave(highs, lows, closes, bullish);

  const wantReading = bullish ? "BUY" : "SELL";
  const hat = step1.reading === wantReading && step2.reading === wantReading ? wantReading : "no hat";

  // Check 1: candlestick, on the hourly chart, within a short trailing lookback.
  const candlestickHits = hourlyBars.length > 0 ? detectCandlestickPatterns(hourlyBars, { lookback: 5 }) : [];
  const wantDirection = bullish ? "bullish" : "bearish";
  const candlestickHit = candlestickHits.find((h) => h.state === "TRIGGERED" && h.direction === wantDirection) ?? null;

  // Check 2: volume on the most significant (latest) candle, above its own hour-slot average.
  let volumeCheck = null;
  if (hourlyBars.length > 0) {
    const latestBar = hourlyBars[hourlyBars.length - 1];
    const hourSlotAverage = hourSlotAverageVolume(hourlyBars, latestBar, hourSlotVolumeLookbackSessions);
    volumeCheck = {
      latestVolume: latestBar.volume,
      hourSlotAverage,
      aboveHourSlotAverage: hourSlotAverage == null ? null : latestBar.volume > hourSlotAverage,
      candleSupportsDirection: bullish ? latestBar.close > latestBar.open : latestBar.close < latestBar.open,
    };
  }

  // Check 3: EMA 5 PCO/NCO with 13 or 26 in the last 3 candles -- skipped
  // when the pattern from check 1 is a morning/evening star (this project
  // does not detect double bottom/top on the hourly chart's own trigger
  // path today, so only the candlestick half of the documented exception is
  // wired).
  const skipEmaCheck = candlestickHit != null && (candlestickHit.patternName === "Morning Star" || candlestickHit.patternName === "Evening Star");
  const emaCrossoverCheck = evaluateEmaCrossoverCheck(closes, bullish, skipEmaCheck);

  return {
    step1,
    step2,
    hat,
    checks: {
      candlestick: candlestickHit,
      volume: volumeCheck,
      emaCrossover: emaCrossoverCheck,
      emaCrossoverSkippedReason: skipEmaCheck ? "morning/evening star signal -- EMA crossover would arrive too late" : null,
    },
    sourceLocator: SMM_HAT_LOCATOR,
  };
}

// RSI and MACD-histogram regular bullish divergence for the /buy-setup-analysis
// page, evaluated independently per the user's own instruction ("do not
// silently convert RSI OR MACD into RSI AND MACD, or vice versa" -- there is
// no combined/aggregate verdict here at all; see buy-setup's page-level
// documentation for why any aggregate reversal read stays MANUAL_REVIEW).
//
// Regular bullish divergence, as specified: a confirmed lower low in price
// AND a confirmed higher low in the indicator, at matching pivots. Price
// pivots are the same fractal-confirmed lows chart-structure.js's
// findConfirmedPivots already detects (reused, not reimplemented) -- so
// look-ahead prevention is inherited directly from that module's own
// contract (a pivot is never reported until `pivotRightWindow` bars exist
// after it). The indicator value compared at each price-pivot bar is read
// from the indicator's own already-computed series
// (features/indicators.js's rsiSeries / macdHistogramSeries), never
// recalculated with a different formula.

import { findConfirmedPivots } from "./chart-structure.js";
import { rsiSeries, macdHistogramSeries } from "../features/indicators.js";

/**
 * @param {import("../providers/types.js").Bar[]} bars oldest-first
 * @param {(number|null)[]} indicatorSeries same length as `bars`
 * @param {{pivotLeftWindow:number, pivotRightWindow:number, lookback:number}} params
 * @param {string} indicatorName "rsi" | "macd_histogram" -- for the persisted evidence row only
 */
function detectRegularBullishDivergence(bars, indicatorSeries, { pivotLeftWindow, pivotRightWindow, lookback }, indicatorName) {
  const base = { indicator: indicatorName, pricePivot1: null, pricePivot2: null, indicatorPivot1Value: null, indicatorPivot2Value: null };
  if (!bars || bars.length < pivotLeftWindow + pivotRightWindow + 1) {
    return { ...base, result: "NO_DATA", reason: "not enough bars to confirm a price pivot" };
  }

  const { lows: pricePivots } = findConfirmedPivots(bars, pivotLeftWindow, pivotRightWindow);
  const withinLookback = pricePivots.filter((p) => p.index >= bars.length - lookback);
  if (withinLookback.length < 2) {
    return { ...base, result: "NO_DATA", reason: "fewer than 2 confirmed price-low pivots within the divergence lookback window" };
  }

  // The two most recent confirmed price-low pivots, oldest first.
  const [prior, latest] = withinLookback.slice(-2);
  const indicatorPrior = indicatorSeries[prior.index] ?? null;
  const indicatorLatest = indicatorSeries[latest.index] ?? null;
  if (indicatorPrior == null || indicatorLatest == null) {
    return {
      ...base,
      pricePivot1: prior,
      pricePivot2: latest,
      result: "NO_DATA",
      reason: `${indicatorName} has no value at one or both confirmed pivot bars`,
    };
  }

  const priceLowerLow = latest.price < prior.price;
  if (!priceLowerLow) {
    return {
      ...base,
      pricePivot1: prior,
      pricePivot2: latest,
      indicatorPivot1Value: indicatorPrior,
      indicatorPivot2Value: indicatorLatest,
      result: "NOT_APPLICABLE",
      reason: "price did not make a confirmed lower low at the most recent pivot -- no bearish-price setup exists for a bullish divergence to resolve against",
    };
  }

  const indicatorHigherLow = indicatorLatest > indicatorPrior;
  return {
    ...base,
    pricePivot1: prior,
    pricePivot2: latest,
    indicatorPivot1Value: indicatorPrior,
    indicatorPivot2Value: indicatorLatest,
    result: indicatorHigherLow ? "PASS" : "FAIL",
    reason: indicatorHigherLow
      ? `price made a lower low (${prior.price} -> ${latest.price}) while ${indicatorName} made a higher low (${indicatorPrior.toFixed(2)} -> ${indicatorLatest.toFixed(2)})`
      : `price made a lower low but ${indicatorName} did not make a higher low -- momentum confirms the new low, no divergence`,
  };
}

/**
 * @param {import("../providers/types.js").Bar[]} bars oldest-first, 15-minute
 * @param {{rsiPeriod:number, pivotLeftWindow:number, pivotRightWindow:number, lookback:number}} params
 */
export function detectRsiBullishDivergence(bars, { rsiPeriod, pivotLeftWindow, pivotRightWindow, lookback }) {
  const closes = (bars ?? []).map((b) => b.close);
  const series = rsiSeries(closes, rsiPeriod);
  return detectRegularBullishDivergence(bars, series, { pivotLeftWindow, pivotRightWindow, lookback }, "rsi");
}

/**
 * @param {import("../providers/types.js").Bar[]} bars oldest-first, 15-minute
 * @param {{macdFast:number, macdSlow:number, macdSignal:number, pivotLeftWindow:number, pivotRightWindow:number, lookback:number}} params
 */
export function detectMacdBullishDivergence(bars, { macdFast, macdSlow, macdSignal, pivotLeftWindow, pivotRightWindow, lookback }) {
  const closes = (bars ?? []).map((b) => b.close);
  const series = macdHistogramSeries(closes, macdFast, macdSlow, macdSignal);
  return detectRegularBullishDivergence(bars, series, { pivotLeftWindow, pivotRightWindow, lookback }, "macd_histogram");
}

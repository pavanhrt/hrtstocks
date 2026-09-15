// Deterministic daily chart-structure detection for the /buy-setup-analysis
// page: confirmed support/resistance levels, an upside breakout (level +
// candle + volume confirmation), and a rising/falling/sideways channel.
//
// This is genuinely new logic (no existing module in this codebase detects
// support/resistance or channels) -- every free parameter it needs
// (pivot window, level-grouping tolerance, minimum touch count, breakout
// buffer, minimum channel pivots, channel slope threshold) is read from
// config/parameters.yaml's buy_setup_analysis_defaults, a disclosed,
// versioned PROJECT_DEFAULT block (see that file's own comments -- none of
// these numbers come from a source document). Reuses features/indicators.js's
// averageVolume for the volume-confirmation half of a breakout, exactly the
// same helper features/structure.js's rangeBreakoutWithVolume already uses.
//
// Pivots are confirmed with a standard fractal window (N bars strictly
// lower/higher on both sides): a candidate at index i is only ever reported
// once `rightWindow` bars exist AFTER it in the supplied array, so a pivot
// can never be "confirmed" using bars that had not yet happened relative to
// it -- the caller is responsible for only ever passing bars up to (and
// including) the run's own as_of cutoff, never beyond it.

import { averageVolume } from "../features/indicators.js";

/**
 * @param {import("../providers/types.js").Bar[]} bars oldest-first
 * @param {number} leftWindow
 * @param {number} rightWindow
 * @returns {{highs: {index:number,date:string,price:number}[], lows: {index:number,date:string,price:number}[]}}
 */
export function findConfirmedPivots(bars, leftWindow, rightWindow) {
  const highs = [];
  const lows = [];
  for (let i = leftWindow; i <= bars.length - 1 - rightWindow; i++) {
    let isHigh = true;
    let isLow = true;
    for (let j = i - leftWindow; j <= i + rightWindow; j++) {
      if (j === i) continue;
      if (bars[j].high > bars[i].high) isHigh = false;
      if (bars[j].low < bars[i].low) isLow = false;
    }
    if (isHigh) highs.push({ index: i, date: bars[i].date, price: bars[i].high });
    if (isLow) lows.push({ index: i, date: bars[i].date, price: bars[i].low });
  }
  return { highs, lows };
}

/**
 * Groups nearby pivot prices (within `tolerance`, a fraction of price) into
 * candidate levels, keeping only levels touched at least `minTouches` times.
 * A single untouched-twice pivot is a swing point, not yet a "level."
 * @param {{index:number,date:string,price:number}[]} pivots
 * @param {number} tolerance
 * @param {number} minTouches
 */
export function groupIntoLevels(pivots, tolerance, minTouches) {
  const sorted = [...pivots].sort((a, b) => a.price - b.price);
  const groups = [];
  for (const pivot of sorted) {
    const last = groups[groups.length - 1];
    if (last && Math.abs(pivot.price - last.avgPrice) <= last.avgPrice * tolerance) {
      last.touches.push(pivot);
      last.avgPrice = last.touches.reduce((sum, t) => sum + t.price, 0) / last.touches.length;
    } else {
      groups.push({ avgPrice: pivot.price, touches: [pivot] });
    }
  }
  return groups
    .filter((g) => g.touches.length >= minTouches)
    .map((g) => ({
      level: g.avgPrice,
      touchCount: g.touches.length,
      touchDates: g.touches.map((t) => t.date),
    }));
}

/**
 * Confirmed support (nearest level below `lastClose`) and resistance
 * (nearest level above `lastClose`) from this bar series' own confirmed
 * pivots. Returns null for either side when no level with the required
 * touch count exists on that side -- never invents one.
 * @param {import("../providers/types.js").Bar[]} bars oldest-first
 * @param {{pivotLeftWindow:number, pivotRightWindow:number, tolerance:number, minTouches:number}} params
 */
export function detectSupportResistance(bars, { pivotLeftWindow, pivotRightWindow, tolerance, minTouches }) {
  if (!bars || bars.length < pivotLeftWindow + pivotRightWindow + 1) {
    return { support: null, resistance: null, confirmedPivotCount: 0 };
  }
  const { highs, lows } = findConfirmedPivots(bars, pivotLeftWindow, pivotRightWindow);
  const lastClose = bars[bars.length - 1].close;
  const resistanceLevels = groupIntoLevels(highs, tolerance, minTouches).filter((l) => l.level > lastClose);
  const supportLevels = groupIntoLevels(lows, tolerance, minTouches).filter((l) => l.level < lastClose);
  const resistance = resistanceLevels.sort((a, b) => a.level - b.level)[0] ?? null;
  const support = supportLevels.sort((a, b) => b.level - a.level)[0] ?? null;
  return { support, resistance, confirmedPivotCount: highs.length + lows.length };
}

/**
 * An upside breakout requires the LATEST bar's close to clear the
 * resistance level by `breakoutBuffer` (never a mere wick-through) AND its
 * volume to exceed the trailing average by `volumeMultiplier` -- the same
 * two-part test features/structure.js's rangeBreakoutWithVolume already
 * applies to Dow-structure ranges, applied here to a detected
 * support/resistance level instead. Returns nulls (never a guessed
 * true/false) when there isn't a full volume-lookback window.
 * @param {import("../providers/types.js").Bar[]} bars oldest-first
 * @param {number|null} resistanceLevel
 * @param {{breakoutBuffer:number, volumeLookback:number, volumeMultiplier:number}} params
 */
export function detectBreakout(bars, resistanceLevel, { breakoutBuffer, volumeLookback, volumeMultiplier }) {
  if (resistanceLevel == null || !bars || bars.length < volumeLookback + 1) {
    return { breakoutDetected: null, breakoutCandleDate: null, breakoutVolumeConfirmed: null };
  }
  const last = bars[bars.length - 1];
  const clearedLevel = last.close > resistanceLevel * (1 + breakoutBuffer);
  const volumes = bars.map((b) => b.volume);
  const avgVolume = averageVolume(volumes.slice(0, -1), volumeLookback);
  if (avgVolume == null) return { breakoutDetected: null, breakoutCandleDate: null, breakoutVolumeConfirmed: null };
  const volumeConfirmed = last.volume > avgVolume * volumeMultiplier;
  return {
    breakoutDetected: clearedLevel,
    breakoutCandleDate: clearedLevel ? last.date : null,
    breakoutVolumeConfirmed: clearedLevel ? volumeConfirmed : null,
  };
}

function linearFit(points) {
  const n = points.length;
  if (n < 2) return null;
  const sumX = points.reduce((s, p) => s + p.x, 0);
  const sumY = points.reduce((s, p) => s + p.y, 0);
  const sumXY = points.reduce((s, p) => s + p.x * p.y, 0);
  const sumXX = points.reduce((s, p) => s + p.x * p.x, 0);
  const denom = n * sumXX - sumX * sumX;
  if (denom === 0) return null;
  const slope = (n * sumXY - sumX * sumY) / denom;
  const intercept = (sumY - slope * sumX) / n;
  return { slope, intercept };
}

/**
 * Fits an independent trendline through the confirmed swing highs and swing
 * lows (least-squares), reports the channel's current upper/lower boundary
 * at `currentIndex`, and classifies its slope as rising/falling/sideways
 * against a disclosed relative-slope threshold. Returns type
 * "NOT_APPLICABLE" (never a guessed direction) when there are not enough
 * confirmed pivots on both sides to fit a meaningful line.
 * @param {{index:number,price:number}[]} highs confirmed, oldest-first
 * @param {{index:number,price:number}[]} lows confirmed, oldest-first
 * @param {number} currentIndex the bar index the boundaries should be evaluated at (typically bars.length - 1)
 * @param {{minPivots:number, slopeThreshold:number}} params
 */
export function detectChannel(highs, lows, currentIndex, { minPivots, slopeThreshold }) {
  if (highs.length < 2 || lows.length < 2 || highs.length + lows.length < minPivots) {
    return { type: "NOT_APPLICABLE", upper: null, lower: null, reason: "fewer than the required confirmed pivots on both sides" };
  }
  const highFit = linearFit(highs.map((p) => ({ x: p.index, y: p.price })));
  const lowFit = linearFit(lows.map((p) => ({ x: p.index, y: p.price })));
  if (!highFit || !lowFit) {
    return { type: "NOT_APPLICABLE", upper: null, lower: null, reason: "degenerate pivot fit (all pivots at the same index)" };
  }
  const upper = highFit.slope * currentIndex + highFit.intercept;
  const lower = lowFit.slope * currentIndex + lowFit.intercept;
  const scale = (upper + lower) / 2;
  if (!(scale > 0)) return { type: "NOT_APPLICABLE", upper: null, lower: null, reason: "non-positive price scale" };
  const relativeSlope = (highFit.slope + lowFit.slope) / 2 / scale;
  const type = relativeSlope > slopeThreshold ? "rising" : relativeSlope < -slopeThreshold ? "falling" : "sideways";
  return { type, upper, lower, reason: null };
}

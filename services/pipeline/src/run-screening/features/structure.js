// Multi-timeframe aggregation and Dow-structure classification.
// Bars are oldest-first: [{ date, open, high, low, close, volume }, ...].
//
// The BUY/SELL Signal Playbooks describe Dow structure as a visual exercise
// ("walk the monthly pivots and label them HH / HL / LH / LL"). This module
// operationalizes that with the zigzag threshold the playbooks themselves
// specify (~5% monthly/weekly, ~2-3% daily -- see config/parameters.yaml's
// zigzag_* parameters) rather than inventing an unrelated threshold.

import { averageVolume } from "./indicators.js";

function weekKeyOf(dateStr) {
  const d = new Date(dateStr + "T00:00:00Z");
  const isoDay = (d.getUTCDay() + 6) % 7; // 0 = Monday
  d.setUTCDate(d.getUTCDate() - isoDay);
  return d.toISOString().slice(0, 10);
}

function monthKeyOf(dateStr) {
  return dateStr.slice(0, 7); // 'YYYY-MM'
}

/**
 * Aggregates daily bars into weekly or monthly bars: first open, max high,
 * min low, last close, summed volume -- exactly the method the playbooks
 * document for "if a timeframe is missing, build it by aggregation".
 * @param {import("../providers/types.js").Bar[]} dailyBars - oldest-first
 * @param {"weekly"|"monthly"} unit
 */
export function aggregateBars(dailyBars, unit) {
  const keyFn = unit === "weekly" ? weekKeyOf : monthKeyOf;
  const groups = new Map();
  for (const bar of dailyBars) {
    const key = keyFn(bar.date);
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(bar);
  }
  const out = [];
  for (const group of groups.values()) {
    out.push({
      date: group[group.length - 1].date,
      open: group[0].open,
      high: Math.max(...group.map((b) => b.high)),
      low: Math.min(...group.map((b) => b.low)),
      close: group[group.length - 1].close,
      volume: group.reduce((sum, b) => sum + b.volume, 0),
    });
  }
  return out;
}

/**
 * True when the most recent daily bar falls inside a still-open week/month
 * boundary -- the playbooks' "say plainly when the most recent candle is
 * still forming" rule, made checkable.
 */
export function isLatestPeriodPartial(dailyBars, unit, asOfDate = dailyBars.at(-1)?.date) {
  if (!asOfDate) return null;
  const keyFn = unit === "weekly" ? weekKeyOf : monthKeyOf;
  const lastBarKey = keyFn(dailyBars[dailyBars.length - 1].date);
  return keyFn(asOfDate) === lastBarKey && (unit === "weekly" ? isBeforeWeekClose(asOfDate) : isBeforeMonthClose(asOfDate));
}

function isBeforeWeekClose(dateStr) {
  const d = new Date(dateStr + "T00:00:00Z");
  return d.getUTCDay() !== 5; // NSE week closes Friday
}

function isBeforeMonthClose(dateStr) {
  const d = new Date(dateStr + "T00:00:00Z");
  const lastDay = new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth() + 1, 0)).getUTCDate();
  return d.getUTCDate() !== lastDay;
}

/**
 * Standard zigzag walk, shared by zigzagPivots (confirmed pivots only, the
 * long-standing public shape) and zigzagPivotsWithUnconfirmedLeg (which also
 * exposes the still-forming extreme at the end of the series). Confirms a
 * pivot once price retraces `thresholdPct` from the running extreme,
 * alternating high/low. Deterministic and re-runnable; the only free
 * parameter is the threshold itself, from config/parameters.yaml's zigzag_*
 * values (playbook-documented ranges).
 */
function walkZigzag(bars, thresholdPct) {
  const pivots = [];
  let trendDir = null; // 'up' | 'down'
  let extremeHigh = bars[0].high;
  let extremeHighIdx = 0;
  let extremeLow = bars[0].low;
  let extremeLowIdx = 0;

  for (let i = 1; i < bars.length; i++) {
    const bar = bars[i];
    if (trendDir === null) {
      if (bar.high > extremeHigh) {
        extremeHigh = bar.high;
        extremeHighIdx = i;
      }
      if (bar.low < extremeLow) {
        extremeLow = bar.low;
        extremeLowIdx = i;
      }
      const upMove = (extremeHigh - bars[0].low) / bars[0].low;
      const downMove = (bars[0].high - extremeLow) / bars[0].high;
      if (upMove >= thresholdPct) {
        pivots.push({ type: "low", index: 0, price: bars[0].low, date: bars[0].date });
        trendDir = "up";
      } else if (downMove >= thresholdPct) {
        pivots.push({ type: "high", index: 0, price: bars[0].high, date: bars[0].date });
        trendDir = "down";
      }
      continue;
    }
    if (trendDir === "up") {
      if (bar.high > extremeHigh) {
        extremeHigh = bar.high;
        extremeHighIdx = i;
      }
      const retrace = (extremeHigh - bar.low) / extremeHigh;
      if (retrace >= thresholdPct) {
        pivots.push({ type: "high", index: extremeHighIdx, price: extremeHigh, date: bars[extremeHighIdx].date });
        trendDir = "down";
        extremeLow = bar.low;
        extremeLowIdx = i;
      }
    } else {
      if (bar.low < extremeLow) {
        extremeLow = bar.low;
        extremeLowIdx = i;
      }
      const retrace = (bar.high - extremeLow) / extremeLow;
      if (retrace >= thresholdPct) {
        pivots.push({ type: "low", index: extremeLowIdx, price: extremeLow, date: bars[extremeLowIdx].date });
        trendDir = "up";
        extremeHigh = bar.high;
        extremeHighIdx = i;
      }
    }
  }
  return { pivots, trendDir, extremeHigh, extremeHighIdx, extremeLow, extremeLowIdx };
}

/**
 * @returns {{type: "high"|"low", index: number, price: number, date: string}[]}
 */
export function zigzagPivots(bars, thresholdPct) {
  if (bars.length < 2) return [];
  return walkZigzag(bars, thresholdPct).pivots;
}

/**
 * Same confirmed pivots as zigzagPivots, plus the current *unconfirmed*
 * leg -- the extreme price since the last confirmed pivot that has not yet
 * retraced far enough to be confirmed itself. Required so a chart/direction
 * classification can show "price is currently making a new high, but it
 * isn't a confirmed HH yet" without that unconfirmed move being allowed to
 * change the confirmed trend state (classifyDowStructure only ever sees
 * `.confirmed`).
 * @returns {{confirmed: {type: "high"|"low", index: number, price: number, date: string}[], unconfirmedLeg: {type: "high"|"low", price: number, date: string}|null}}
 */
export function zigzagPivotsWithUnconfirmedLeg(bars, thresholdPct) {
  if (bars.length < 2) return { confirmed: [], unconfirmedLeg: null };
  const walk = walkZigzag(bars, thresholdPct);
  if (walk.trendDir === null) {
    // Not even the first pivot has confirmed yet -- there's a running
    // extreme in both directions, but no established trend to call either
    // one "the" unconfirmed leg of, so this is honestly not computable yet.
    return { confirmed: walk.pivots, unconfirmedLeg: null };
  }
  // Mirrors classifyDowStructure's own convention (see rangeBreakoutWithVolume's
  // callers): while trendDir is "up", the pipeline is looking for the next
  // HIGH to confirm, so the unconfirmed leg is the running high; symmetric
  // for "down".
  const unconfirmedLeg =
    walk.trendDir === "up"
      ? { type: "high", price: walk.extremeHigh, date: bars[walk.extremeHighIdx].date }
      : { type: "low", price: walk.extremeLow, date: bars[walk.extremeLowIdx].date };
  return { confirmed: walk.pivots, unconfirmedLeg };
}

/**
 * Tolerance-aware level comparison shared by classifyDowStructure and
 * labelPivotSequence, so "roughly equal" means the same thing in both.
 * @returns {"higher"|"lower"|"equal"}
 */
export function compareLevel(curr, prev, tol) {
  if (curr > prev * (1 + tol)) return "higher";
  if (curr < prev * (1 - tol)) return "lower";
  return "equal";
}

/**
 * Classifies Dow structure from the last two swing highs and last two swing
 * lows, against the playbooks' M1/M3/S1/S3 tables. "Roughly equal" (sideways)
 * uses a disclosed 0.5% tolerance -- the source tables don't give one.
 * @returns {{state: "uptrend_intact"|"downtrend_intact"|"confirmed_reversal_bullish"|"confirmed_reversal_bearish"|"sideways"|"ambiguous", lastSwingHigh: number|null, lastSwingLow: number|null}}
 */
export function classifyDowStructure(pivots, lastClose) {
  const highs = pivots.filter((p) => p.type === "high");
  const lows = pivots.filter((p) => p.type === "low");
  if (highs.length < 2 || lows.length < 2) {
    return { state: "ambiguous", lastSwingHigh: highs.at(-1)?.price ?? null, lastSwingLow: lows.at(-1)?.price ?? null };
  }
  const h1 = highs[highs.length - 2].price;
  const h2 = highs[highs.length - 1].price;
  const l1 = lows[lows.length - 2].price;
  const l2 = lows[lows.length - 1].price;
  const tol = 0.005;
  const higherHigh = compareLevel(h2, h1, tol) === "higher";
  const lowerHigh = compareLevel(h2, h1, tol) === "lower";
  const higherLow = compareLevel(l2, l1, tol) === "higher";
  const lowerLow = compareLevel(l2, l1, tol) === "lower";

  if (higherHigh && higherLow && lastClose > l2) {
    return { state: "uptrend_intact", lastSwingHigh: h2, lastSwingLow: l2 };
  }
  if (lowerHigh && lowerLow && lastClose < h2) {
    return { state: "downtrend_intact", lastSwingHigh: h2, lastSwingLow: l2 };
  }
  if (lastClose > h2 && higherLow) {
    return { state: "confirmed_reversal_bullish", lastSwingHigh: h2, lastSwingLow: l2 };
  }
  if (lastClose < l2 && lowerHigh) {
    return { state: "confirmed_reversal_bearish", lastSwingHigh: h2, lastSwingLow: l2 };
  }
  if (higherHigh && lowerLow) {
    return { state: "ambiguous", lastSwingHigh: h2, lastSwingLow: l2 }; // HH+LL: expanding/volatile per M3's explicit FAIL case
  }
  if ((lowerHigh && higherLow) || (!higherHigh && !lowerHigh && !higherLow && !lowerLow)) {
    return { state: "sideways", lastSwingHigh: h2, lastSwingLow: l2 };
  }
  return { state: "ambiguous", lastSwingHigh: h2, lastSwingLow: l2 };
}

/**
 * The sideways-range conditional-pass test M1/M3/S1/S3 all specify: a close
 * beyond the range on above-average volume. Returns nulls (never fabricated
 * false) when there isn't a full volume-lookback window to average.
 */
export function rangeBreakoutWithVolume(structure, bars, volumeLookback, volumeMultiplier) {
  if (structure.lastSwingHigh == null || structure.lastSwingLow == null || bars.length < volumeLookback + 1) {
    return { up: null, down: null };
  }
  const volumes = bars.map((b) => b.volume);
  const lastVolume = volumes[volumes.length - 1];
  const avgVolume = averageVolume(volumes.slice(0, -1), volumeLookback);
  const lastClose = bars[bars.length - 1].close;
  if (avgVolume == null) return { up: null, down: null };
  return {
    up: lastClose > structure.lastSwingHigh && lastVolume > avgVolume * volumeMultiplier,
    down: lastClose < structure.lastSwingLow && lastVolume > avgVolume * volumeMultiplier,
  };
}

/**
 * Walks the full zigzag pivot list and tags every swing HH/HL/LH/LL against
 * its predecessor of the same type (a high compared to the prior high, a low
 * compared to the prior low) -- the Dow-theory labeling the BUY/SELL Signal
 * Playbooks describe as a visual exercise, made mechanical. The first high
 * and first low in the series have no predecessor to compare against and are
 * labeled "H"/"L" (sequence origin) rather than guessed. A within-tolerance
 * repeat is its own explicit EH/EL (equal-high/equal-low) label -- a range,
 * not a manufactured HH/HL. (Earlier versions of this function folded an
 * equal pivot into HH/HL, biasing structure toward "bullish" whenever price
 * merely retested a level; that was wrong and is what this fixes.) Uses the
 * same 0.5% tolerance as classifyDowStructure so "roughly equal" means the
 * same thing everywhere in this module.
 * @returns {{type: "HH"|"HL"|"LH"|"LL"|"EH"|"EL"|"H"|"L", price: number, date: string}[]} oldest-first
 */
export function labelPivotSequence(pivots, tolerancePct = 0.005) {
  let prevHigh = null;
  let prevLow = null;
  const labeled = [];
  for (const pivot of pivots) {
    if (pivot.type === "high") {
      let label;
      if (prevHigh == null) label = "H";
      else {
        const cmp = compareLevel(pivot.price, prevHigh, tolerancePct);
        label = cmp === "higher" ? "HH" : cmp === "lower" ? "LH" : "EH";
      }
      labeled.push({ type: label, price: pivot.price, date: pivot.date });
      prevHigh = pivot.price;
    } else {
      let label;
      if (prevLow == null) label = "L";
      else {
        const cmp = compareLevel(pivot.price, prevLow, tolerancePct);
        label = cmp === "higher" ? "HL" : cmp === "lower" ? "LL" : "EL";
      }
      labeled.push({ type: label, price: pivot.price, date: pivot.date });
      prevLow = pivot.price;
    }
  }
  return labeled;
}

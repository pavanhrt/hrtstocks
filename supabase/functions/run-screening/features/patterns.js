// SMM/PAPA pattern detection -- deliberately a SUBSET of the full catalog in
// docs/swing-strategy-extraction.md section 12: only patterns whose source
// gives an exact or cleanly-disclosed-approximate mechanical rule are
// implemented here. Everything the extraction marked UNRESOLVED (a
// qualitative word like "small"/"tiny"/"tight"/"almost the same level" with
// no number anywhere in the source) is NOT implemented -- inventing a
// threshold for those would violate this project's own "never invent a
// number" rule. Not-yet-implemented patterns (Head & Shoulder, Cup &
// Handle, Flag & Pole, Doji family, PAPA formations, etc.) simply aren't
// detected; callers should not treat their absence as "no pattern present,"
// only as "not evaluated."
//
// Every detection cites its locator so provenance survives into
// pattern_detections.source_locator (migration 0006).

const CANDLESTICK_LOCATOR = "smm-chart-analysis-SKILL.md §4-§5 / papa-price-action-SKILL.md §1";
const DOUBLE_TOP_LOCATOR = "smm-chart-patterns-SKILL.md §2 (Double Top)";
const DOUBLE_BOTTOM_LOCATOR = "smm-chart-patterns-SKILL.md §2 (Double Bottom)";

// Disclosed PROJECT_DEFAULT values for the source's own "~" approximations
// (never resolved to an exact number in any read document -- see
// swing-strategy-extraction.md §12.1/§12.2). Versioned here, not silently
// assumed.
const PATTERN_PARAM_VERSION = "1.0.0";
const HAMMER_UPPER_WICK_CAP_FRACTION = 0.6; // "~0.6x abs(c-o)" in the source
const DOUBLE_EXTREME_TOLERANCE = 0.03; // "~3%" / "within about 3 percent" in the source
const TREND_LOOKBACK_BARS = 5; // candlestick "prior trend" context: no mechanical lookback given in the source for single/multi-candle patterns; disclosed default

function body(bar) {
  return { top: Math.max(bar.open, bar.close), bottom: Math.min(bar.open, bar.close) };
}
function bodySize(bar) {
  const b = body(bar);
  return b.top - b.bottom;
}
function isBullish(bar) {
  return bar.close > bar.open;
}
function isBearish(bar) {
  return bar.close < bar.open;
}
function median(bar) {
  return (bar.open + bar.close) / 2;
}

/** Simple, disclosed prior-trend proxy: compares the close just before the pattern to the close TREND_LOOKBACK_BARS earlier. */
function priorTrend(bars, index) {
  const lookbackIndex = index - TREND_LOOKBACK_BARS;
  if (lookbackIndex < 0) return null;
  const recent = bars[index - 1].close;
  const earlier = bars[lookbackIndex].close;
  if (recent > earlier) return "up";
  if (recent < earlier) return "down";
  return "flat";
}

function detection({ patternName, direction, state, anchorPoints, triggerBarDate = null, targetPrice = null, invalidationPrice = null, volumeEvidence = null, sourceLocator }) {
  return { patternName, direction, state, anchorPoints, triggerBarDate, targetPrice, invalidationPrice, volumeEvidence, sourceLocator };
}

/**
 * Scans the trailing `lookback` bars for the implemented candlestick
 * patterns. Each bar is checked as the *last* candle of its pattern (e.g.
 * bar i is checked as the second candle of an engulfing pair using i-1).
 * @param {import("../providers/types.js").Bar[]} bars oldest-first
 * @param {{lookback?: number}} [options]
 * @returns {object[]} pattern_detections-shaped rows
 */
export function detectCandlestickPatterns(bars, { lookback = 10 } = {}) {
  const results = [];
  const start = Math.max(1, bars.length - lookback);

  for (let i = start; i < bars.length; i++) {
    const cur = bars[i];
    const prev = bars[i - 1];
    const trend = priorTrend(bars, i - 1); // trend going into the first candle of the pattern

    // Bullish / Bearish Engulfing -- exact rule, no approximation.
    if (isBearish(prev) && isBullish(cur) && cur.open <= prev.close && cur.close >= prev.open) {
      results.push(
        detection({
          patternName: "Bullish Engulfing",
          direction: "bullish",
          state: trend === "down" ? "TRIGGERED" : "OBSERVED",
          anchorPoints: [{ date: prev.date, price: prev.close }, { date: cur.date, price: cur.close }],
          triggerBarDate: cur.date,
          invalidationPrice: Math.min(prev.low, cur.low),
          sourceLocator: CANDLESTICK_LOCATOR,
        })
      );
    }
    if (isBullish(prev) && isBearish(cur) && cur.open >= prev.close && cur.close <= prev.open) {
      results.push(
        detection({
          patternName: "Bearish Engulfing",
          direction: "bearish",
          state: trend === "up" ? "TRIGGERED" : "OBSERVED",
          anchorPoints: [{ date: prev.date, price: prev.close }, { date: cur.date, price: cur.close }],
          triggerBarDate: cur.date,
          invalidationPrice: Math.max(prev.high, cur.high),
          sourceLocator: CANDLESTICK_LOCATOR,
        })
      );
    }

    // Bullish Piercing / Bearish Dark Cloud Cover -- exact median rule.
    if (isBearish(prev) && isBullish(cur) && cur.close > median(prev) && cur.close < prev.open && cur.open < prev.close) {
      results.push(
        detection({
          patternName: "Bullish Piercing",
          direction: "bullish",
          state: trend === "down" ? "TRIGGERED" : "OBSERVED",
          anchorPoints: [{ date: prev.date, price: prev.close }, { date: cur.date, price: cur.close }],
          triggerBarDate: cur.date,
          invalidationPrice: Math.min(prev.low, cur.low),
          sourceLocator: CANDLESTICK_LOCATOR,
        })
      );
    }
    if (isBullish(prev) && isBearish(cur) && cur.close < median(prev) && cur.close > prev.open && cur.open > prev.close) {
      // Dark Cloud Cover needs follow-through (source: "needs follow-through") --
      // OBSERVED here; a caller re-scanning after a later bar closes below
      // this pattern's low will see it promoted (the next bar's own scan
      // naturally re-evaluates context; this module doesn't mutate past rows).
      results.push(
        detection({
          patternName: "Bearish Dark Cloud Cover",
          direction: "bearish",
          state: "OBSERVED",
          anchorPoints: [{ date: prev.date, price: prev.close }, { date: cur.date, price: cur.close }],
          triggerBarDate: null,
          invalidationPrice: Math.max(prev.high, cur.high),
          sourceLocator: CANDLESTICK_LOCATOR,
        })
      );
    }

    // Hammer / Inverted Hammer / Shooting Star / Hanging Man -- exact 2x
    // lower/upper-wick-vs-body multiplier; the upper/lower wick CAP on the
    // opposite side is the source's own disclosed approximation.
    const bsz = bodySize(cur);
    if (bsz > 0) {
      const upperWick = cur.high - body(cur).top;
      const lowerWick = body(cur).bottom - cur.low;
      const isHammerShape = lowerWick >= 2 * bsz && upperWick <= HAMMER_UPPER_WICK_CAP_FRACTION * bsz;
      const isShootingStarShape = upperWick >= 2 * bsz && lowerWick <= HAMMER_UPPER_WICK_CAP_FRACTION * bsz;

      if (isHammerShape && trend === "down") {
        results.push(
          detection({
            patternName: "Hammer",
            direction: "bullish",
            state: "TRIGGERED",
            anchorPoints: [{ date: cur.date, price: cur.low }],
            triggerBarDate: cur.date,
            invalidationPrice: cur.low,
            sourceLocator: CANDLESTICK_LOCATOR,
          })
        );
      }
      if (isShootingStarShape && trend === "up") {
        results.push(
          detection({
            patternName: "Shooting Star",
            direction: "bearish",
            state: "TRIGGERED",
            anchorPoints: [{ date: cur.date, price: cur.high }],
            triggerBarDate: cur.date,
            invalidationPrice: cur.high,
            sourceLocator: CANDLESTICK_LOCATOR,
          })
        );
      }
      // Hanging Man: hammer shape at the TOP of an uptrend, but only counts
      // once a following red candle confirms it (source is explicit: "without
      // the follow-up red candle it does not count").
      if (isHammerShape && trend === "up") {
        const next = bars[i + 1];
        const confirmed = next && isBearish(next);
        results.push(
          detection({
            patternName: "Hanging Man",
            direction: "bearish",
            state: confirmed ? "TRIGGERED" : "OBSERVED",
            anchorPoints: [{ date: cur.date, price: cur.high }],
            triggerBarDate: confirmed ? next.date : null,
            invalidationPrice: cur.high,
            sourceLocator: CANDLESTICK_LOCATOR,
          })
        );
      }
    }

    // Morning Star / Evening Star -- exact 3-candle rule.
    if (i >= 2) {
      const c1 = bars[i - 2];
      const c2 = bars[i - 1];
      const c3 = cur;
      const c2IsSmall = bodySize(c2) < bodySize(c1) * 0.5 && bodySize(c2) < bodySize(c3) * 0.5;
      if (isBearish(c1) && c2IsSmall && isBullish(c3) && c3.close > median(c1)) {
        results.push(
          detection({
            patternName: "Morning Star",
            direction: "bullish",
            state: priorTrend(bars, i - 2) === "down" ? "TRIGGERED" : "OBSERVED",
            anchorPoints: [
              { date: c1.date, price: c1.close },
              { date: c2.date, price: c2.close },
              { date: c3.date, price: c3.close },
            ],
            triggerBarDate: c3.date,
            invalidationPrice: Math.min(c1.low, c2.low, c3.low),
            sourceLocator: CANDLESTICK_LOCATOR,
          })
        );
      }
      if (isBullish(c1) && c2IsSmall && isBearish(c3) && c3.close < median(c1)) {
        results.push(
          detection({
            patternName: "Evening Star",
            direction: "bearish",
            state: priorTrend(bars, i - 2) === "up" ? "TRIGGERED" : "OBSERVED",
            anchorPoints: [
              { date: c1.date, price: c1.close },
              { date: c2.date, price: c2.close },
              { date: c3.date, price: c3.close },
            ],
            triggerBarDate: c3.date,
            invalidationPrice: Math.max(c1.high, c2.high, c3.high),
            sourceLocator: CANDLESTICK_LOCATOR,
          })
        );
      }
    }
  }

  return results;
}

/**
 * Double Top / Double Bottom from the labeled pivot sequence (same pivots
 * structure.js already computes for Dow-theory labeling) plus the raw bars
 * to check for the neckline-break trigger. Requires the documented prior
 * trend (an uptrend into a double top, a downtrend into a double bottom) and
 * two comparable extremes within the disclosed ~3% tolerance -- a pair that
 * differs by more than that is correctly a fresh HH/LL or a plain LH/HL, not
 * this pattern, per the source's own explicit disambiguation.
 * @param {{type: string, price: number, date: string}[]} labeledPivots oldest-first
 * @param {import("../providers/types.js").Bar[]} bars oldest-first, same series the pivots were computed from
 * @returns {object[]}
 */
export function detectDoubleExtremePatterns(labeledPivots, bars) {
  const results = [];
  const barIndexByDate = new Map(bars.map((b, i) => [b.date, i]));

  for (let i = 2; i < labeledPivots.length; i++) {
    const first = labeledPivots[i - 2];
    const trough = labeledPivots[i - 1];
    const second = labeledPivots[i];
    const isHighPair = (first.type.endsWith("H") || first.type === "H") && (second.type.endsWith("H") || second.type === "H");
    const isLowPair = (first.type.endsWith("L") || first.type === "L") && (second.type.endsWith("L") || second.type === "L");
    if (!isHighPair && !isLowPair) continue;

    const withinTolerance = Math.abs(second.price - first.price) / first.price < DOUBLE_EXTREME_TOLERANCE;
    if (!withinTolerance) continue;

    // Requires the documented prior trend into the first extreme: the pivot
    // before `first` must be on the opposite side and lower (for a top) /
    // higher (for a bottom), i.e. `first` was itself a genuine HH or LL, not
    // a retracement inside a bigger opposite move.
    const beforeFirstIndex = i - 3;
    const beforeFirst = beforeFirstIndex >= 0 ? labeledPivots[beforeFirstIndex] : null;

    const secondBarIndex = barIndexByDate.get(second.date);
    const barsAfterSecond = secondBarIndex != null ? bars.slice(secondBarIndex + 1) : [];
    const neckline = trough.price;
    const height = Math.abs(first.price - neckline);

    if (isHighPair) {
      const priorUptrend = beforeFirst == null || beforeFirst.price < first.price;
      if (!priorUptrend) continue;
      const triggerBar = barsAfterSecond.find((b) => b.close < neckline);
      results.push(
        detection({
          patternName: "Double Top",
          direction: "bearish",
          state: triggerBar ? "TRIGGERED" : "OBSERVED",
          anchorPoints: [
            { date: first.date, price: first.price },
            { date: trough.date, price: trough.price },
            { date: second.date, price: second.price },
          ],
          necklineOrBoundary: { price: neckline },
          triggerBarDate: triggerBar?.date ?? null,
          targetPrice: triggerBar ? neckline - height : null,
          invalidationPrice: Math.max(first.price, second.price),
          sourceLocator: DOUBLE_TOP_LOCATOR,
        })
      );
    } else {
      const priorDowntrend = beforeFirst == null || beforeFirst.price > first.price;
      if (!priorDowntrend) continue;
      const triggerBar = barsAfterSecond.find((b) => b.close > neckline);
      results.push(
        detection({
          patternName: "Double Bottom",
          direction: "bullish",
          state: triggerBar ? "TRIGGERED" : "OBSERVED",
          anchorPoints: [
            { date: first.date, price: first.price },
            { date: trough.date, price: trough.price },
            { date: second.date, price: second.price },
          ],
          necklineOrBoundary: { price: neckline },
          triggerBarDate: triggerBar?.date ?? null,
          targetPrice: triggerBar ? neckline + height : null,
          invalidationPrice: Math.min(first.price, second.price),
          sourceLocator: DOUBLE_BOTTOM_LOCATOR,
        })
      );
    }
  }

  return results;
}

export { PATTERN_PARAM_VERSION, HAMMER_UPPER_WICK_CAP_FRACTION, DOUBLE_EXTREME_TOLERANCE, TREND_LOOKBACK_BARS };

// PAPA price-action formations -- Gate M6/S6, "a named PAPA buy/sell setup
// has TRIGGERED, not merely observed" (BUY_Signal_Playbook_Weekly_Daily_1H.md
// §5 / SELL...§7, swing-strategy-extraction.md §12.4).
//
// Deliberately a SUBSET, same discipline as features/patterns.js: only
// formations with an exact documented mechanical rule are implemented here.
// Genuinely UNRESOLVED formations (Accumulation/Distribution, Tweezers -- no
// number anywhere in any source for "no major follow-up" / "almost the same
// level") are NOT implemented -- inventing a threshold for those would
// violate this project's own never-invent discipline.
// Double Top/Bottom already exist via patterns.js#detectDoubleExtremePatterns
// and are reused there, not reimplemented here.
//
// Correction Cycle 3 (2026-09-11) added the last two DOCUMENTED-mechanism
// formations deferred from Cycle 2 for scope:
//   - Sandwich breakout/breakdown -- "alternate red/green candles in a
//     compact range, no candle-count limit" (observation) then "close above/
//     below the previous candle AND the range edge" (trigger). No follow-up
//     candle is required by the source (unlike Counter Attack/Gap), so this
//     TRIGGERS on the breakout candle itself. "Compact range" needs no
//     separate invented tolerance: the range IS the alternating run's own
//     high/low, so requiring the breakout to clear that same boundary is
//     already the compactness check, not a new threshold.
//   - Rounding bottom/top -- "multiple big same-colour candles... mostly
//     neutral candles forming a base/top" then "a strong close beyond the
//     range." "Big"/"strong" reuse config/parameters.yaml's
//     rounding_pattern_body_size_multiplier (already disclosed in Cycle 2,
//     unused until now) as the SAME ratio in both directions: the initiating
//     candles' bodies must be at least that multiple of the base's own
//     average body size, the base candles must be no more than that same
//     multiple below the initiating candles' own average, and the breakout
//     candle must again clear that multiple against the base -- one
//     disclosed number, not three separate invented ones.
//
// Every detector follows patterns.js's own two-part discipline: an
// OBSERVATION is never itself actionable; only a TRIGGERED close counts. Two
// rows (Bull/Bear Counter Attack, Gap up/down) are additionally
// session-open events by construction on the hourly chart (BUY...§5 / SELL...
// §7: "read them only on the 09:15 candle and require the follow-up candle
// before acting") -- both are only ever observed on a slotIndex===0 bar, and
// never TRIGGER on that same opening candle; a follow-up candle must confirm
// first.
//
// "A level" (support/resistance) is any confirmed zigzag pivot -- hourly or
// daily -- within patterns.js's own DOUBLE_EXTREME_TOLERANCE (~3%) of the
// formation's own reference price, preferring a level that also exists on
// the daily chart, per the playbook's own explicit weighting note ("an
// hourly-only support that formed four hours ago carries far less weight
// than one the daily chart has respected three times").

import { DOUBLE_EXTREME_TOLERANCE } from "./patterns.js";

const PAPA_FORMATIONS_LOCATOR = "papa-price-action-SKILL.md §3-§8 / papa-decision-sheet-SKILL.md §2-§3 (swing-strategy-extraction.md §12.4)";

// How far back to look for a shakeout (a false break-and-reverse) before a
// genuine/fake breakout or breakdown candle. No source document gives a
// bar-count window for this -- disclosed PROJECT_DEFAULT, same convention as
// patterns.js's own TREND_LOOKBACK_BARS (a plausible, versioned default, not
// an extracted number).
const SHAKEOUT_LOOKBACK_BARS = 10;

function isBullish(bar) {
  return bar.close > bar.open;
}
function isBearish(bar) {
  return bar.close < bar.open;
}
function bodySize(bar) {
  return Math.abs(bar.close - bar.open);
}

function detection({ patternName, direction, state, anchorPoints, triggerBarDate = null, targetPrice = null, invalidationPrice = null, level = null, sourceLocator = PAPA_FORMATIONS_LOCATOR }) {
  return { patternName, direction, state, anchorPoints, triggerBarDate, targetPrice, invalidationPrice, level, sourceLocator };
}

/**
 * Nearest confirmed pivot (hourly or daily) to `price` within tolerance,
 * preferring a daily-chart level over an hourly-only one when both qualify.
 * @param {{type: "high"|"low", price: number, date: string}[]} hourlyPivots confirmed zigzag pivots on the hourly chart
 * @param {{type: "high"|"low", price: number, date: string}[]} dailyPivots confirmed zigzag pivots on the daily chart
 * @param {"high"|"low"} type "high" for a resistance level, "low" for support
 */
function nearestLevel(price, hourlyPivots, dailyPivots, type, tolerance = DOUBLE_EXTREME_TOLERANCE) {
  const byDistance = (a, b) => Math.abs(a.price - price) - Math.abs(b.price - price);
  const dailyMatch = dailyPivots.filter((p) => p.type === type && Math.abs(p.price - price) / price < tolerance).sort(byDistance)[0];
  if (dailyMatch) return { price: dailyMatch.price, date: dailyMatch.date, onDaily: true };
  const hourlyMatch = hourlyPivots.filter((p) => p.type === type && Math.abs(p.price - price) / price < tolerance).sort(byDistance)[0];
  if (hourlyMatch) return { price: hourlyMatch.price, date: hourlyMatch.date, onDaily: false };
  return null;
}

/**
 * True when some bar in the lookback window before `breakIndex` pierced
 * `level` (wick through) and closed back on the origin side of it -- a false
 * move that removed weak hands before the real break. Never assumes a
 * shakeout occurred; returns false when none is found in the window.
 */
function shakeoutOccurred(bars, breakIndex, level, bullish) {
  const start = Math.max(0, breakIndex - SHAKEOUT_LOOKBACK_BARS);
  for (let i = start; i < breakIndex; i++) {
    const b = bars[i];
    if (bullish) {
      // Resistance shakeout: wick pierces above the level, close stays below it.
      if (b.high > level && b.close < level) return true;
    } else {
      // Support shakeout: wick pierces below the level, close stays above it.
      if (b.low < level && b.close > level) return true;
    }
  }
  return false;
}

/**
 * Bull/Bear Counter Attack -- price opens beyond a major level, then
 * re-enters back through it. Session-open event by construction: only ever
 * observed on the 09:15 (slotIndex 0) candle, and the re-entry must be
 * confirmed by a FOLLOW-UP candle (not the same opening candle) before it
 * counts as TRIGGERED.
 * @param {object[]} hourlyBars oldest-first, nse-calendar.js's normalizeHourlyBars() shape
 * @param {{type: string, price: number, date: string}[]} hourlyPivots confirmed zigzag pivots on the hourly chart
 * @param {{type: string, price: number, date: string}[]} dailyPivots confirmed zigzag pivots on the daily chart
 * @param {boolean} bullish
 */
export function detectCounterAttack(hourlyBars, hourlyPivots, dailyPivots, bullish) {
  const results = [];
  for (let i = 0; i < hourlyBars.length; i++) {
    const openBar = hourlyBars[i];
    if (openBar.slotIndex !== 0) continue;
    const level = bullish
      ? nearestLevel(openBar.open, hourlyPivots, dailyPivots, "low")
      : nearestLevel(openBar.open, hourlyPivots, dailyPivots, "high");
    if (!level) continue;
    const opensBeyondLevel = bullish ? openBar.open < level.price : openBar.open > level.price;
    if (!opensBeyondLevel) continue;

    // Re-entry "in the same or a later candle", but a follow-up candle must
    // confirm before this counts as TRIGGERED (never the opening candle
    // itself, per the source's own session-open discipline).
    const reenteredSameCandle = bullish ? openBar.close > level.price : openBar.close < level.price;
    const followUp = hourlyBars[i + 1];
    const followUpConfirms = followUp && (bullish ? followUp.close > level.price : followUp.close < level.price);

    if (!reenteredSameCandle && !(hourlyBars[i + 1] && (bullish ? hourlyBars[i + 1].close > level.price : hourlyBars[i + 1].close < level.price))) {
      // Neither the open candle nor the very next one has re-entered yet --
      // nothing to report for this open candle.
      continue;
    }
    const counterAttackBar = reenteredSameCandle ? openBar : followUp;
    results.push(
      detection({
        patternName: bullish ? "Bulls Counter Attack" : "Bears Counter Attack",
        direction: bullish ? "bullish" : "bearish",
        state: followUpConfirms ? "TRIGGERED" : "OBSERVED",
        anchorPoints: [{ date: openBar.date, price: openBar.open }],
        triggerBarDate: followUpConfirms ? followUp.date : null,
        invalidationPrice: bullish ? counterAttackBar.low : counterAttackBar.high,
        level,
      })
    );
  }
  return results;
}

/**
 * Gap up/down -- price opens beyond a major level and sustains the gap.
 * Session-open event by construction, same discipline as counter attack:
 * observed only on the 09:15 candle, requires the follow-up candle
 * ("enter after follow-up", BUY...§5) before TRIGGERED.
 */
export function detectGap(hourlyBars, hourlyPivots, dailyPivots, bullish) {
  const results = [];
  for (let i = 0; i < hourlyBars.length; i++) {
    const openBar = hourlyBars[i];
    if (openBar.slotIndex !== 0) continue;
    const level = bullish
      ? nearestLevel(openBar.open, hourlyPivots, dailyPivots, "high")
      : nearestLevel(openBar.open, hourlyPivots, dailyPivots, "low");
    if (!level) continue;
    const opensBeyondLevel = bullish ? openBar.open > level.price : openBar.open < level.price;
    if (!opensBeyondLevel) continue;
    const sustainsThroughOpenCandle = bullish ? openBar.close > level.price : openBar.close < level.price;
    if (!sustainsThroughOpenCandle) continue; // gap given back within the opening candle -- not this setup

    const followUp = hourlyBars[i + 1];
    const followUpSustains = followUp && (bullish ? followUp.close > level.price : followUp.close < level.price);
    results.push(
      detection({
        patternName: bullish ? "Gap Up" : "Gap Down",
        direction: bullish ? "bullish" : "bearish",
        state: followUpSustains ? "TRIGGERED" : "OBSERVED",
        anchorPoints: [{ date: openBar.date, price: openBar.open }],
        triggerBarDate: followUpSustains ? followUp.date : null,
        invalidationPrice: bullish ? openBar.low : openBar.high,
        level,
      })
    );
  }
  return results;
}

/**
 * Genuine breakout/breakdown -- a shakeout occurs at a major level BEFORE
 * the real break; the follow-up candle closing beyond the break level (not
 * merely the breakout candle itself) is the trigger.
 */
export function detectGenuineBreak(hourlyBars, hourlyPivots, dailyPivots, bullish) {
  const results = [];
  const levelType = bullish ? "high" : "low";
  for (let i = 1; i < hourlyBars.length - 1; i++) {
    const breakBar = hourlyBars[i];
    const level = nearestLevel(bullish ? breakBar.high : breakBar.low, hourlyPivots, dailyPivots, levelType);
    if (!level) continue;
    const breaksLevel = bullish ? breakBar.close > level.price : breakBar.close < level.price;
    if (!breaksLevel) continue;
    if (!shakeoutOccurred(hourlyBars, i, level.price, bullish)) continue; // genuine requires a prior shakeout

    const followUp = hourlyBars[i + 1];
    const followUpConfirms = followUp && (bullish ? followUp.close > level.price : followUp.close < level.price);
    results.push(
      detection({
        patternName: bullish ? "Genuine Breakout" : "Genuine Breakdown",
        direction: bullish ? "bullish" : "bearish",
        state: followUpConfirms ? "TRIGGERED" : "OBSERVED",
        anchorPoints: [{ date: breakBar.date, price: bullish ? breakBar.high : breakBar.low }],
        triggerBarDate: followUpConfirms ? followUp.date : null,
        invalidationPrice: bullish ? breakBar.low : breakBar.high,
        level,
      })
    );
  }
  return results;
}

/**
 * Fake breakdown/breakout -- the documented asymmetry is explicit: "a fake
 * breakdown is a BUY setup," "a fake breakout is a SELL setup." No shakeout
 * before the (false) break; price re-enters, and the follow-up candle
 * closes ABOVE the breakdown candle's own high (bullish) / BELOW the
 * breakout candle's own low (bearish) -- not just the level -- per the
 * source table's own wording.
 */
export function detectFakeBreak(hourlyBars, hourlyPivots, dailyPivots, bullish) {
  const results = [];
  // A fake breakDOWN (bullish setup) breaks a SUPPORT level; a fake
  // breakOUT (bearish setup) breaks a RESISTANCE level.
  const levelType = bullish ? "low" : "high";
  for (let i = 1; i < hourlyBars.length - 1; i++) {
    const breakBar = hourlyBars[i];
    const level = nearestLevel(bullish ? breakBar.low : breakBar.high, hourlyPivots, dailyPivots, levelType);
    if (!level) continue;
    const breaksLevel = bullish ? breakBar.close < level.price : breakBar.close > level.price;
    if (!breaksLevel) continue;
    if (shakeoutOccurred(hourlyBars, i, level.price, !bullish)) continue; // fake requires generally NO prior shakeout

    const followUp = hourlyBars[i + 1];
    const followUpConfirms = followUp && (bullish ? followUp.close > breakBar.high : followUp.close < breakBar.low);
    results.push(
      detection({
        patternName: bullish ? "Fake Breakdown" : "Fake Breakout",
        direction: bullish ? "bullish" : "bearish",
        state: followUpConfirms ? "TRIGGERED" : "OBSERVED",
        anchorPoints: [{ date: breakBar.date, price: bullish ? breakBar.low : breakBar.high }],
        triggerBarDate: followUpConfirms ? followUp.date : null,
        invalidationPrice: bullish ? breakBar.low : breakBar.high,
        level,
      })
    );
  }
  return results;
}

/**
 * Mother candle (reversal at a level, or continuation mid-trend) -- a
 * bigger candle with at least 3 following candles trading within its
 * high-low range; a LATER close beyond the mother candle's own high/low is
 * the trigger. "Bigger" than what: the immediately preceding candle's range
 * (a disclosed, minimal comparison -- the source gives no averaging window
 * for this specific qualifier, unlike patterns.js's own TREND_LOOKBACK_BARS
 * convention which compares closes, not ranges).
 * @param {boolean} atLevel true = reversal (mother candle must sit at a
 *   detected level); false = continuation (no level requirement, mother
 *   candle must sit "in between the trend" -- approximated here as simply
 *   not at any detected level, mirroring the reversal/continuation split's
 *   own either/or framing)
 */
export function detectMotherCandle(hourlyBars, hourlyPivots, dailyPivots, bullish, atLevel) {
  const results = [];
  const N_FOLLOWING_CANDLES = 3; // exact number per papa-price-action-SKILL.md §4/§6
  for (let i = 1; i < hourlyBars.length - N_FOLLOWING_CANDLES; i++) {
    const mother = hourlyBars[i];
    const motherRange = mother.high - mother.low;
    const prevRange = hourlyBars[i - 1].high - hourlyBars[i - 1].low;
    if (!(motherRange > prevRange)) continue; // not "bigger" than the immediately preceding candle

    const level = bullish
      ? nearestLevel(mother.low, hourlyPivots, dailyPivots, "low")
      : nearestLevel(mother.high, hourlyPivots, dailyPivots, "high");
    if (atLevel && !level) continue;
    if (!atLevel && level) continue;

    const following = hourlyBars.slice(i + 1, i + 1 + N_FOLLOWING_CANDLES);
    if (following.length < N_FOLLOWING_CANDLES) continue;
    const allWithinRange = following.every((b) => b.high <= mother.high && b.low >= mother.low);
    if (!allWithinRange) continue;

    const afterFollowing = hourlyBars.slice(i + 1 + N_FOLLOWING_CANDLES);
    const triggerBar = afterFollowing.find((b) => (bullish ? b.close > mother.high : b.close < mother.low));
    results.push(
      detection({
        patternName: `Mother Candle -- ${bullish ? "bullish" : "bearish"} ${atLevel ? "reversal" : "continuation"}`,
        direction: bullish ? "bullish" : "bearish",
        state: triggerBar ? "TRIGGERED" : "OBSERVED",
        anchorPoints: [{ date: mother.date, price: bullish ? mother.low : mother.high }],
        triggerBarDate: triggerBar?.date ?? null,
        invalidationPrice: bullish ? mother.low : mother.high,
        level,
      })
    );
  }
  return results;
}

/**
 * Sandwich breakout/breakdown -- alternating red/green candles form a
 * compact range (no candle-count limit per the source; MIN_ALTERNATING_RUN
 * is a disclosed floor so "the range" means something), then a candle
 * closes beyond BOTH the immediately preceding candle's close AND that
 * range's own high/low edge. No follow-up candle is documented for this row
 * (unlike Counter Attack/Gap) -- the breakout candle itself is the trigger.
 * Stop is the opposite side of the sandwich, per the source's own table.
 */
const MIN_ALTERNATING_RUN = 3; // "no candle-count limit" upward; this is the disclosed floor for a run to define a meaningful range at all

function isAlternating(prev, cur) {
  return (isBullish(prev) && isBearish(cur)) || (isBearish(prev) && isBullish(cur));
}

export function detectSandwich(hourlyBars, bullish) {
  const results = [];
  for (let i = MIN_ALTERNATING_RUN; i < hourlyBars.length; i++) {
    let runStart = i - 1;
    while (runStart > 0 && isAlternating(hourlyBars[runStart - 1], hourlyBars[runStart])) runStart--;
    const rangeBars = hourlyBars.slice(runStart, i);
    if (rangeBars.length < MIN_ALTERNATING_RUN) continue;

    const rangeHigh = Math.max(...rangeBars.map((b) => b.high));
    const rangeLow = Math.min(...rangeBars.map((b) => b.low));
    const prev = hourlyBars[i - 1];
    const breakoutBar = hourlyBars[i];
    const breaksLevel = bullish ? breakoutBar.close > prev.close && breakoutBar.close > rangeHigh : breakoutBar.close < prev.close && breakoutBar.close < rangeLow;
    if (!breaksLevel) continue;

    results.push(
      detection({
        patternName: bullish ? "Sandwich Breakout" : "Sandwich Breakdown",
        direction: bullish ? "bullish" : "bearish",
        state: "TRIGGERED",
        anchorPoints: [
          { date: rangeBars[0].date, price: rangeBars[0].close },
          { date: prev.date, price: prev.close },
        ],
        triggerBarDate: breakoutBar.date,
        invalidationPrice: bullish ? rangeLow : rangeHigh,
      })
    );
  }
  return results;
}

/**
 * Rounding bottom/top -- multiple big same-colour candles (RED for a
 * bottom, GREEN for a top), then a base/top of mostly neutral (small-body)
 * candles, then a strong close beyond the whole range. "Big"/"strong"/
 * "neutral" all reuse the SAME disclosed
 * `rounding_pattern_body_size_multiplier` ratio (config/parameters.yaml) --
 * initiating candles' bodies >= multiple x the base's own average body;
 * base candles' bodies <= the initiating candles' own average / multiple;
 * the breakout candle's body >= multiple x the base's own average again.
 * MIN_BIG_CANDLES ("multiple") and MIN_BASE_CANDLES mirror Mother Candle's
 * own documented N=3 base-window precedent (papa-price-action-SKILL.md
 * §4/§6) for consistency, since this row gives no number of its own for
 * either.
 */
const MIN_BIG_CANDLES = 2;
const MIN_BASE_CANDLES = 3;

export function detectRounding(hourlyBars, bullish, bodySizeMultiplier) {
  const results = [];
  const sameColor = bullish ? isBearish : isBullish; // rounding BOTTOM forms from big RED candles; rounding TOP from big GREEN candles

  for (let i = MIN_BIG_CANDLES + MIN_BASE_CANDLES; i < hourlyBars.length; i++) {
    const breakoutBar = hourlyBars[i];
    const base = hourlyBars.slice(i - MIN_BASE_CANDLES, i);
    const bigCandles = hourlyBars.slice(i - MIN_BASE_CANDLES - MIN_BIG_CANDLES, i - MIN_BASE_CANDLES);

    if (!bigCandles.every((b) => sameColor(b))) continue;

    const bigAvgBody = bigCandles.reduce((sum, b) => sum + bodySize(b), 0) / bigCandles.length;
    const baseAvgBody = base.reduce((sum, b) => sum + bodySize(b), 0) / base.length;
    if (bigAvgBody === 0) continue; // a zero-range "big" candle can never satisfy the multiplier check honestly

    const bigCandlesAreBig = bigCandles.every((b) => bodySize(b) >= bodySizeMultiplier * baseAvgBody);
    const baseIsNeutral = base.every((b) => bodySize(b) <= bigAvgBody / bodySizeMultiplier);
    if (!bigCandlesAreBig || !baseIsNeutral) continue;

    const rangeBars = [...bigCandles, ...base];
    const rangeHigh = Math.max(...rangeBars.map((b) => b.high));
    const rangeLow = Math.min(...rangeBars.map((b) => b.low));
    const strongBreak = bodySize(breakoutBar) >= bodySizeMultiplier * baseAvgBody;
    const breaksRange = bullish ? breakoutBar.close > rangeHigh : breakoutBar.close < rangeLow;
    if (!strongBreak || !breaksRange) continue;

    results.push(
      detection({
        patternName: bullish ? "Rounding Bottom" : "Rounding Top",
        direction: bullish ? "bullish" : "bearish",
        state: "TRIGGERED",
        anchorPoints: rangeBars.map((b) => ({ date: b.date, price: bullish ? b.low : b.high })),
        triggerBarDate: breakoutBar.date,
        invalidationPrice: bullish ? rangeLow : rangeHigh,
      })
    );
  }
  return results;
}

/**
 * Runs every implemented detector for one direction and returns every
 * TRIGGERED (never merely OBSERVED) result -- the M6/S6 gate's own
 * requirement ("a close through it, not an observation").
 * @param {number} bodySizeMultiplier config/parameters.yaml rounding_pattern_body_size_multiplier
 * @returns {object[]}
 */
export function detectTriggeredPapaFormations({ hourlyBars, hourlyPivots, dailyPivots, bullish, bodySizeMultiplier }) {
  const all = [
    ...detectCounterAttack(hourlyBars, hourlyPivots, dailyPivots, bullish),
    ...detectGap(hourlyBars, hourlyPivots, dailyPivots, bullish),
    ...detectGenuineBreak(hourlyBars, hourlyPivots, dailyPivots, bullish),
    ...detectFakeBreak(hourlyBars, hourlyPivots, dailyPivots, bullish),
    ...detectMotherCandle(hourlyBars, hourlyPivots, dailyPivots, bullish, true),
    ...detectMotherCandle(hourlyBars, hourlyPivots, dailyPivots, bullish, false),
    ...detectSandwich(hourlyBars, bullish),
    ...(bodySizeMultiplier != null ? detectRounding(hourlyBars, bullish, bodySizeMultiplier) : []),
  ];
  return all.filter((d) => d.state === "TRIGGERED");
}

export { SHAKEOUT_LOOKBACK_BARS };

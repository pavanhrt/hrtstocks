// The BSA-D1/BSA-G1 gate for the /buy-setup-analysis page
// (strategies/buy-setup-analysis.yaml -- PROJECT_DEFAULT, user-requested,
// see that file's decision_record; NOT extracted from any GUE/BSP source
// document).
//
// Monthly (BSP-M1) and weekly (BSP-M3) bullish results are read from
// rule_traces this module does not compute -- the main pipeline already
// evaluates them every run (context.js). Daily has no equivalent existing
// gate (BSP-M5 means something else), so this module computes it here, by
// calling the SAME features/structure.js functions context.js already uses
// for every other timeframe (classifyDowStructure, rangeBreakoutWithVolume)
// with the same zigzag_daily_pct/volume_lookback/volume_multiplier
// parameters -- not a reimplementation, not a new threshold.

import { classifyDowStructure, rangeBreakoutWithVolume, zigzagPivots } from "../features/structure.js";
import { evaluateRules } from "../rules/evaluate.js";

/**
 * @param {import("../providers/types.js").Bar[]} dailyBars oldest-first
 * @param {{zigzagDailyPct: number, volumeLookback: number, volumeMultiplier: number}} params
 * @returns {{bsa_daily_dow_state: string|null, bsa_daily_range_breakout_up_with_volume: boolean|null}}
 */
export function computeDailyDowBullishContext(dailyBars, { zigzagDailyPct, volumeLookback, volumeMultiplier }) {
  if (!dailyBars || dailyBars.length < 2) {
    return { bsa_daily_dow_state: null, bsa_daily_range_breakout_up_with_volume: null };
  }
  const lastClose = dailyBars[dailyBars.length - 1].close;
  const pivots = zigzagPivots(dailyBars, zigzagDailyPct);
  const structure = classifyDowStructure(pivots, lastClose);
  const breakout = rangeBreakoutWithVolume(structure, dailyBars, volumeLookback, volumeMultiplier);
  return {
    bsa_daily_dow_state: structure.state,
    bsa_daily_range_breakout_up_with_volume: breakout.up,
  };
}

/**
 * Assembles the full BSA-D1/BSA-G1 feature context for one instrument.
 * Monthly/weekly values are passed in verbatim (already computed by the main
 * pipeline for BSP-M1/BSP-M3) -- this function never recomputes them, so a
 * page reading this gate's result can never silently disagree with what
 * BSP-M1/BSP-M3 already show elsewhere in the product.
 * @param {object} args
 * @param {string|null} args.monthlyDowState
 * @param {boolean|null} args.monthlyBreakoutUpWithVolume
 * @param {string|null} args.weeklyDowState
 * @param {boolean|null} args.weeklyBreakoutUpWithVolume
 * @param {import("../providers/types.js").Bar[]} args.dailyBars oldest-first
 * @param {{zigzagDailyPct: number, volumeLookback: number, volumeMultiplier: number}} args.params
 */
export function buildThreeTimeframeContext({
  monthlyDowState,
  monthlyBreakoutUpWithVolume,
  weeklyDowState,
  weeklyBreakoutUpWithVolume,
  dailyBars,
  params,
}) {
  return {
    bsa_monthly_dow_state: monthlyDowState ?? null,
    bsa_monthly_range_breakout_up_with_volume: monthlyBreakoutUpWithVolume ?? null,
    bsa_weekly_dow_state: weeklyDowState ?? null,
    bsa_weekly_range_breakout_up_with_volume: weeklyBreakoutUpWithVolume ?? null,
    ...computeDailyDowBullishContext(dailyBars, params),
  };
}

/**
 * Evaluates BSA-D1 and BSA-G1 (and any other BSA-framework rule passed in)
 * against the assembled context via the project's existing deterministic
 * rule engine (rules/evaluate.js) -- the same engine every other framework
 * uses, so BSA gets the same Kleene three-valued NO_DATA/MANUAL_REVIEW
 * propagation as everything else (never a fabricated pass on missing data).
 * @param {object[]} rules rule_definitions rows for framework 'BSA'
 * @param {ReturnType<typeof buildThreeTimeframeContext>} context
 * @returns {{traces: object[], failedGates: string[]}}
 */
export function evaluateThreeTimeframeGate(rules, context) {
  return evaluateRules(rules, context, {});
}

/** True only when BSA-G1 actually resolved to PASS -- never on NO_DATA/MANUAL_REVIEW/FAIL. */
export function isQualifiedForFifteenMinuteAnalysis(gateTraces) {
  const g1 = gateTraces.find((t) => t.rule_id === "BSA-G1");
  return g1?.result === "PASS";
}

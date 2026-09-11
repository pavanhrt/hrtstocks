// Non-route hourly gate conditions for the swing (Weekly->Daily->1H) BUY/SELL
// playbooks -- distinct from features/hourly-routes.js's Elliott setup
// detectors (BUY-1..5/SELL-1..5, gate WBP-M5/WSP-S5). The condition
// implemented here belongs to a different part of the source documents: the
// "combination matrix" (BUY_Signal_Playbook_Weekly_Daily_1H.md §11,
// SELL_Signal_Playbook_Weekly_Daily_1H.md §13), which sits alongside -- not
// inside -- the 8 mandatory gates table (§8/§10) that
// strategies/buy-swing.yaml/sell-swing.yaml's WBP-/WSP- rule IDs encode. Kept
// in its own module rather than folded into hourly-routes.js (whose own
// header comment scopes it to Elliott setups only) or the WBP-/WSP- YAML
// (whose IDs are reserved for the literal 8-gate table, per
// swing-strategy-extraction.md §13 conflict #10's own warning against
// merging different taxonomies/ID sets).
//
// "Hourly ADX below 14, or flat under 25 -> WAIT" (same locators as above).
// The 14/25 thresholds resolve swing-strategy-extraction.md §13 conflict #4
// (ADX < 14 vs. the general ADX < 20 no-trend reading) as a disclosed
// PROJECT_DEFAULT scoped strictly to this hourly check -- see
// config/parameters.yaml's swing_hourly_adx_wait_below/
// swing_hourly_adx_flat_ceiling comment for the full resolution rationale,
// and that doc's own §13 conflict #4 entry for the resolution note. This
// module never changes swing_analysis_results.final_action (WBP-M5..M8/
// WSP-S5..S8 already keep that WAIT regardless of any evidence gathered
// here) -- it only adds disclosed evidence to pending_conditions, the same
// role route_evidence already plays.

import { adx, adxSlope } from "./indicators.js";

/**
 * @param {object} params
 * @param {number[]} params.highs
 * @param {number[]} params.lows
 * @param {number[]} params.closes hourly OHLC, oldest-first
 * @param {number} params.period ADX/DMI period (documented 14, config/parameters.yaml adx_dmi_period)
 * @param {number} params.waitBelowThreshold config/parameters.yaml swing_hourly_adx_wait_below
 * @param {number} params.flatCeiling config/parameters.yaml swing_hourly_adx_flat_ceiling
 * @param {number} [params.slopeLookback] passed through to adxSlope
 * @returns {{adx: number, plusDI: number, minusDI: number, slope: string|null, wait: boolean, reason: string|null}|null}
 *   the observed ADX/slope evidence and the resulting WAIT verdict, or null
 *   when ADX isn't available yet (not enough hourly bars) -- never a guessed
 *   verdict over missing data
 */
export function evaluateHourlyAdxCondition({ highs, lows, closes, period, waitBelowThreshold, flatCeiling, slopeLookback }) {
  const { adx: adxValue, plusDI, minusDI } = adx(highs, lows, closes, period);
  if (adxValue == null) return null;

  const slope = adxSlope(highs, lows, closes, period, slopeLookback);
  const belowWaitThreshold = adxValue < waitBelowThreshold;
  const flatAndLow = slope === "flat" && adxValue < flatCeiling;

  let reason = null;
  if (belowWaitThreshold) reason = `hourly ADX ${adxValue.toFixed(2)} < ${waitBelowThreshold}`;
  else if (flatAndLow) reason = `hourly ADX ${adxValue.toFixed(2)} is flat and < ${flatCeiling}`;

  return { adx: adxValue, plusDI, minusDI, slope, wait: belowWaitThreshold || flatAndLow, reason };
}

// Daily/15-minute positive EMA crossover evidence for the /buy-setup-analysis
// page. Periods (5/13/26) reuse config/parameters.yaml's already-documented
// `ema_periods`, per the user's own instruction to reuse existing project
// periods rather than invent new ones. The confirmation window (how many
// trailing bars still count as "a recent crossover") is not documented
// anywhere and is a disclosed PROJECT_DEFAULT
// (buy_setup_analysis_defaults.ema_crossover_confirmation_window in
// config/parameters.yaml) -- labeled as such wherever this evidence is
// persisted, never silently presented as a documented rule.
//
// Reuses features/indicators.js's emaSeries verbatim -- no new EMA formula.

import { emaSeries } from "../features/indicators.js";

/**
 * @param {import("../providers/types.js").Bar[]} bars oldest-first
 * @param {{fastPeriod: number, slowPeriod: number, confirmationWindow: number}} params
 * @returns {{
 *   status: "TRIGGERED"|"ALREADY_ABOVE"|"NOT_TRIGGERED"|"NO_DATA",
 *   fastValue: number|null, slowValue: number|null,
 *   fastPrevious: number|null, slowPrevious: number|null,
 *   crossoverBarDate: string|null, fastPeriod: number, slowPeriod: number,
 *   confirmationWindow: number,
 * }}
 */
export function detectEmaCrossover(bars, { fastPeriod, slowPeriod, confirmationWindow }) {
  const base = { fastPeriod, slowPeriod, confirmationWindow };
  if (!bars || bars.length < 2) {
    return { status: "NO_DATA", fastValue: null, slowValue: null, fastPrevious: null, slowPrevious: null, crossoverBarDate: null, ...base };
  }
  const closes = bars.map((b) => b.close);
  const fastSeries = emaSeries(closes, fastPeriod);
  const slowSeries = emaSeries(closes, slowPeriod);
  const n = closes.length;
  const latest = n - 1;
  const fastValue = fastSeries[latest];
  const slowValue = slowSeries[latest];
  const fastPrevious = fastSeries[latest - 1] ?? null;
  const slowPrevious = slowSeries[latest - 1] ?? null;

  if (fastValue == null || slowValue == null) {
    return { status: "NO_DATA", fastValue: null, slowValue: null, fastPrevious: null, slowPrevious: null, crossoverBarDate: null, ...base };
  }

  // Most recent bar (within the trailing confirmationWindow) where fast
  // crossed from at-or-below slow to strictly above it. A later crossing
  // wins over an earlier one within the same window (only the most recent
  // evidence is "current").
  let crossoverIndex = null;
  const start = Math.max(1, n - confirmationWindow);
  for (let i = start; i < n; i++) {
    if (fastSeries[i] == null || slowSeries[i] == null || fastSeries[i - 1] == null || slowSeries[i - 1] == null) continue;
    if (fastSeries[i - 1] <= slowSeries[i - 1] && fastSeries[i] > slowSeries[i]) {
      crossoverIndex = i;
    }
  }

  const status = crossoverIndex != null ? "TRIGGERED" : fastValue > slowValue ? "ALREADY_ABOVE" : "NOT_TRIGGERED";

  return {
    status,
    fastValue,
    slowValue,
    fastPrevious,
    slowPrevious,
    crossoverBarDate: crossoverIndex != null ? bars[crossoverIndex].date : null,
    ...base,
  };
}

/**
 * "EMA 5 crossing above EMA 13 OR EMA 26" -- evaluates each documented slow
 * period independently and reports TRIGGERED if EITHER shows a fresh
 * crossover within the confirmation window. Never silently narrows an "OR"
 * into an "AND": both per-period results are always returned alongside the
 * combined verdict.
 * @param {import("../providers/types.js").Bar[]} bars oldest-first
 * @param {{fastPeriod: number, slowPeriods: number[], confirmationWindow: number}} params
 */
export function detectPositiveEmaCrossoverEvidence(bars, { fastPeriod, slowPeriods, confirmationWindow }) {
  const perSlowPeriod = slowPeriods.map((slowPeriod) => detectEmaCrossover(bars, { fastPeriod, slowPeriod, confirmationWindow }));
  const anyTriggered = perSlowPeriod.some((r) => r.status === "TRIGGERED");
  const allNoData = perSlowPeriod.every((r) => r.status === "NO_DATA");
  const overallStatus = anyTriggered ? "TRIGGERED" : allNoData ? "NO_DATA" : "NOT_TRIGGERED";
  return { overallStatus, perSlowPeriod };
}

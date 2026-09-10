// Ties together this instrument's Dow-theory swing structure and best-effort
// wave label across all three timeframes the user reviews manually (daily,
// weekly, monthly) into the shape the Direction page and its chart renderer
// need. Kept separate from features/context.js deliberately: context.js
// feeds rule evaluation (changing it touches documented strategy semantics,
// governed by AGENTS.md's change-control rules) while this is a presentation
// derived artifact with its own persistence (instrument_direction table).
//
// This is also where the daily timeframe finally gets a dow_state --
// context.js only wires weekly/monthly today (config/parameters.yaml's
// zigzag_daily_pct has been sitting unused).

import { aggregateBars, zigzagPivots, classifyDowStructure, labelPivotSequence } from "./structure.js";
import { labelWave } from "./wave.js";

const TIMEFRAMES = [
  { label: "daily", paramKey: "zigzag_daily_pct", aggregate: false },
  { label: "weekly", paramKey: "zigzag_weekly_pct", aggregate: true },
  { label: "monthly", paramKey: "zigzag_monthly_pct", aggregate: true },
];

/**
 * @param {import("../providers/types.js").Bar[]} dailyBars oldest-first
 * @param {object} documentedParams config/parameters.yaml's `documented` section
 * @returns {Promise<{daily: object|null, weekly: object|null, monthly: object|null}>}
 */
export async function buildDirectionAnalysis(dailyBars, documentedParams) {
  const result = { daily: null, weekly: null, monthly: null };
  for (const { label, paramKey, aggregate } of TIMEFRAMES) {
    const zigzagPct = documentedParams[paramKey];
    if (zigzagPct == null) continue; // unresolved parameter -- never guess a threshold
    const bars = aggregate ? aggregateBars(dailyBars, label) : dailyBars;
    if (bars.length < 2) continue;

    const rawPivots = zigzagPivots(bars, zigzagPct);
    const lastClose = bars[bars.length - 1].close;
    const structure = classifyDowStructure(rawPivots, lastClose);
    const pivots = labelPivotSequence(rawPivots);
    const wave = labelWave(pivots, structure.state);
    const inputHash = await hashDirectionInputs(pivots, bars[bars.length - 1]);

    result[label] = {
      dowState: structure.state,
      pivots,
      bars, // this timeframe's own bars (aggregated for weekly/monthly) -- needed to render its chart
      lastSwingHigh: structure.lastSwingHigh,
      lastSwingLow: structure.lastSwingLow,
      wave,
      inputHash,
      lastBarDate: bars[bars.length - 1].date,
    };
  }
  return result;
}

/**
 * SHA-256 over the labeled pivots + latest bar (date+close) -- if this is
 * unchanged from the previously stored hash for an instrument/timeframe, the
 * chart and row are left exactly as they are (no re-render, no re-upload).
 */
async function hashDirectionInputs(pivots, lastBar) {
  const payload = JSON.stringify({
    pivots: pivots.map((p) => [p.type, p.price, p.date]),
    lastBar: [lastBar.date, lastBar.close],
  });
  const bytes = new TextEncoder().encode(payload);
  const digest = await crypto.subtle.digest("SHA-256", bytes);
  return Array.from(new Uint8Array(digest))
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
}

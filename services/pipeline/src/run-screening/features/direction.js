// Ties together this instrument's Dow-theory swing structure and best-effort
// wave hypothesis across all three timeframes the user reviews manually
// (daily, weekly, monthly) into the shape the Direction page and its chart
// renderer need. Kept separate from features/context.js deliberately:
// context.js feeds rule evaluation (changing it touches documented strategy
// semantics, governed by AGENTS.md's change-control rules) while this is a
// presentation derived artifact with its own persistence (instrument_direction
// table today; instrument_direction_runs once migration 0006 is applied).
//
// This is also where the daily timeframe finally gets a dow_state --
// context.js only wires weekly/monthly today (config/parameters.yaml's
// zigzag_daily_pct has been sitting unused).

import { aggregateBars, zigzagPivotsWithUnconfirmedLeg, classifyDowStructure, labelPivotSequence } from "./structure.js";
import { labelWave } from "./wave.js";
import { RENDER_VERSION, MAX_BARS } from "../charts/render.js";

// Bump whenever structure.js's pivot-labeling logic or wave.js's hypothesis
// logic changes in a way that could change the result for unchanged inputs
// (e.g. the EH/EL equal-pivot fix, or the wave-progress rewrite this
// version corresponds to) -- included in the chart-input hash so a stored
// chart doesn't stay stale just because the algorithm, not the data,
// changed underneath it (problem #7).
export const ALGORITHM_VERSION = "2.0.0";

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

    const { confirmed: rawPivots, unconfirmedLeg } = zigzagPivotsWithUnconfirmedLeg(bars, zigzagPct);
    const lastClose = bars[bars.length - 1].close;
    const structure = classifyDowStructure(rawPivots, lastClose);
    const pivots = labelPivotSequence(rawPivots);
    const { primary: wave, alternative: waveAlternative } = labelWave(pivots, unconfirmedLeg, structure.state);
    const inputHash = await hashDirectionInputs({ pivots, unconfirmedLeg, bars, zigzagPct });

    result[label] = {
      dowState: structure.state,
      pivots,
      unconfirmedLeg,
      bars, // this timeframe's own bars (aggregated for weekly/monthly) -- needed to render its chart
      lastSwingHigh: structure.lastSwingHigh,
      lastSwingLow: structure.lastSwingLow,
      wave,
      waveAlternative,
      inputHash,
      lastBarDate: bars[bars.length - 1].date,
    };
  }
  return result;
}

/**
 * SHA-256 over everything that could change what gets rendered or stored:
 * the labeled pivots, the current unconfirmed leg, the full bars window the
 * chart actually displays (not just the latest bar -- problem #7's main
 * gap), the zigzag threshold parameter used, and both the pivot/wave
 * algorithm version and the chart renderer version. If any of these change,
 * the hash changes and the chart is regenerated; if none of them change,
 * the existing chart and row are left exactly as they are.
 */
async function hashDirectionInputs({ pivots, unconfirmedLeg, bars, zigzagPct }) {
  const renderedWindow = bars.slice(-MAX_BARS);
  const payload = JSON.stringify({
    pivots: pivots.map((p) => [p.type, p.price, p.date]),
    unconfirmedLeg: unconfirmedLeg ? [unconfirmedLeg.type, unconfirmedLeg.price, unconfirmedLeg.date] : null,
    renderedWindow: renderedWindow.map((b) => [b.date, b.open, b.high, b.low, b.close, b.volume]),
    zigzagPct,
    algorithmVersion: ALGORITHM_VERSION,
    renderVersion: RENDER_VERSION,
  });
  const bytes = new TextEncoder().encode(payload);
  const digest = await crypto.subtle.digest("SHA-256", bytes);
  return Array.from(new Uint8Array(digest))
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
}

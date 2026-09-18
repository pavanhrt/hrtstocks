// Builds the rule-evaluation feature context for the single-instrument FOME
// page -- the bridge between buildFomeTimeframeRow()'s Direction-table rows
// (fome/timeframe-direction.js), live derivative data (OI/premium), and
// strategies/fome.yaml + strategies/fome-single-instrument.yaml's rule
// `inputs`. Reuses the SAME Elliott-wave engine every other strategy in this
// codebase uses (features/structure.js + features/wave.js) for "start of
// impulsive move" -- never a separate approximation.
//
// Every input this project cannot deterministically resolve is set to
// `null` here, not omitted -- rules/evaluate.js's missing-input handling
// already converts a null input into the rule's own `missing_result`
// (NO_DATA/MANUAL_REVIEW), so setting it explicitly (rather than leaving the
// key absent) keeps that behavior uniform and makes the gap visible in the
// context object itself for debugging/tests.

import { zigzagPivotsWithUnconfirmedLeg, labelPivotSequence } from "../features/structure.js";
import { labelWave } from "../features/wave.js";
import { interpretFuturesOi, isBullishOptionOiSupportive, isBearishOptionOiSupportive } from "./oi-interpretation.js";

export const FOME_CONTEXT_VERSION = "1.0.0";

/**
 * "Start of a bullish/bearish impulsive move" (fome.md's Trend qualification
 * clause) is not defined anywhere in the FOME source documents as a
 * mechanical test -- this project resolves it as a disclosed PROJECT_DEFAULT:
 * the current wave (from the same Elliott engine features/context.js already
 * uses for SMM/GUE) is a still-forming wave 1 or wave 3 of an impulse in the
 * matching direction. A completed wave, a corrective structure, or an
 * unconfirmed/low-confidence read never counts.
 */
function isImpulseStart(wave, direction) {
  if (!wave || wave.confidence === "unconfirmed") return null;
  if (wave.structureType !== "impulse" || wave.direction !== direction) return false;
  return wave.waveState === "forming" && (wave.currentWave === "1" || wave.currentWave === "3");
}

/**
 * @param {object} params
 * @param {import("../providers/types.js").Bar[]} params.dailyBars oldest-first
 * @param {object} params.dailyRow buildFomeTimeframeRow("daily", ...) output
 * @param {object} params.documentedParams config/parameters.yaml `documented`
 * @param {object|null} params.derivative shape: {
 *   futures: {priceChangePct, oiChangePct}|null,
 *   atmPutOiChangePct: number|null, atmOrItmCallOiChangePct: number|null,
 *   atmOrItmPutOiChangePct: number|null, atmCallOiChangePct: number|null,
 * } -- null when the instrument has no current derivative eligibility/data.
 */
export function buildFomeRuleContext({ dailyBars, dailyRow, documentedParams, derivative }) {
  const zigzagPct = documentedParams.zigzag_daily_pct;
  let wave = null;
  if (zigzagPct != null && dailyBars.length >= 2 && dailyRow.dowState) {
    const { confirmed, unconfirmedLeg } = zigzagPivotsWithUnconfirmedLeg(dailyBars, zigzagPct);
    const labeled = labelPivotSequence(confirmed);
    wave = labelWave(labeled, unconfirmedLeg, dailyRow.dowState).primary;
  }

  const futuresOi = derivative?.futures ? interpretFuturesOi(derivative.futures) : null;

  return {
    // TIDE MACD (daily MACD line slope, this project's read of "Tide" per
    // SMM's own Tide/Wave/Ripple naming, reused here for FOME's identical term).
    tide_macd_slope: dailyRow.macdState ?? null,
    tide_macd_state: dailyRow.macdState ?? null,

    // TLBO/TLBD ("Trend Line Breakout"/"Breakdown") and bullish/bearish
    // Ungali have no validated deterministic definition anywhere in this
    // project's source register -- always null (UNRESOLVED), never guessed.
    // See strategies/fome-single-instrument.yaml's matching manual_review-
    // sentinel rules.
    trendline_breakout: null,
    trendline_breakdown: null,
    bullish_ungali: null,
    bearish_ungali: null,

    rsi: dailyRow.rsi ?? null,

    bullish_impulse: isImpulseStart(wave, "bullish"),
    bearish_impulse: isImpulseStart(wave, "bearish"),

    option_oi_supportive: derivative
      ? isBullishOptionOiSupportive({
          atmPutOiChangePct: derivative.atmPutOiChangePct,
          atmOrItmCallOiChangePct: derivative.atmOrItmCallOiChangePct,
        })
      : null,
    option_oi_supportive_bearish: derivative
      ? isBearishOptionOiSupportive({
          atmOrItmPutOiChangePct: derivative.atmOrItmPutOiChangePct,
          atmCallOiChangePct: derivative.atmCallOiChangePct,
        })
      : null,

    futures_long_buildup: futuresOi ? futuresOi.state === "long_buildup" : null,
    futures_short_buildup: futuresOi ? futuresOi.state === "short_buildup" : null,

    wave_adx: dailyRow.adx ?? null,
    wave_adx_slope: dailyRow.adxSlope ?? null,
    bollinger_state: dailyRow.bollingerState ?? null,
  };
}

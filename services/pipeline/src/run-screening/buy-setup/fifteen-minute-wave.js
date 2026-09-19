// Runs the EXISTING Elliott/GUE engine (features/structure.js's
// zigzagPivotsWithUnconfirmedLeg/labelPivotSequence/classifyDowStructure +
// features/wave.js's labelWave -- the same engine context.js already uses
// for daily/weekly/monthly, and the same one the Direction page displays)
// against 15-minute bars instead. No new wave logic, no new Elliott rules --
// the GUE-IMPULSE-001/002/003 hard gates in wave.js apply exactly as they do
// elsewhere. Only the zigzag threshold differs per timeframe
// (zigzag_fifteen_minute_pct, config/parameters.yaml -- a disclosed
// PROJECT_DEFAULT, not a documented number, same status as zigzag_hourly_pct).

import { zigzagPivots, zigzagPivotsWithUnconfirmedLeg, classifyDowStructure, labelPivotSequence } from "../features/structure.js";
import { labelWave } from "../features/wave.js";

/**
 * @param {import("../providers/types.js").Bar[]} bars oldest-first, 15-minute, complete candles only
 * @param {number} zigzagPct
 * @returns {{
 *   dowState: string,
 *   structureType: string|null, direction: string|null, currentWave: string|null,
 *   waveState: string|null, confidence: "confirmed"|"tentative"|"unconfirmed",
 *   reason: string, ruleEvidence: object[], invalidationPrice: number|null,
 *   invalidationCondition: string|null, pivotPrices: object[]|null,
 *   alternative: object|null,
 * }}
 */
export function computeFifteenMinuteWave(bars, zigzagPct) {
  if (!bars || bars.length < 2) {
    return {
      dowState: "unavailable",
      structureType: null,
      direction: null,
      currentWave: null,
      waveState: null,
      confidence: "unconfirmed",
      reason: "fewer than 2 fifteen-minute bars -- not enough data to classify structure",
      ruleEvidence: [],
      invalidationPrice: null,
      invalidationCondition: null,
      pivotPrices: null,
      alternative: null,
    };
  }

  const lastClose = bars[bars.length - 1].close;
  const pivots = zigzagPivots(bars, zigzagPct);
  const structure = classifyDowStructure(pivots, lastClose);

  const { confirmed: rawPivots, unconfirmedLeg } = zigzagPivotsWithUnconfirmedLeg(bars, zigzagPct);
  const labeledPivots = labelPivotSequence(rawPivots);
  const { primary, alternative } = labelWave(labeledPivots, unconfirmedLeg, structure.state);

  return {
    dowState: structure.state,
    structureType: primary.structureType,
    direction: primary.direction,
    currentWave: primary.currentWave,
    waveState: primary.waveState,
    confidence: primary.confidence,
    reason: primary.reason,
    ruleEvidence: primary.ruleEvidence ?? [],
    invalidationPrice: primary.invalidationPrice,
    invalidationCondition: primary.invalidationCondition,
    pivotPrices: primary.pivotPrices,
    alternative,
  };
}

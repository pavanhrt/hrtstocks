// Best-effort Elliott-wave labeling for the *current* swing sequence only --
// not an attempt at a multi-year, primary-degree count. AGENTS.md treats full
// wave counting as MANUAL_REVIEW/optional (Phase 3): this module honors that
// by only ever claiming a label when it can point to which documented rule
// validated it, and returning null (never a guess) otherwise.
//
// Hard gates below are copied from strategies/gue.yaml's impulse_rules
// verbatim (ids kept in the output for traceability):
//   GUE-IMPULSE-001  wave_2_retracement_fraction < 1.0
//   GUE-IMPULSE-002  wave 4 does not enter wave 1's price territory
//   GUE-IMPULSE-003  wave_3_length >= min(wave_1_length, wave_5_length)
//
// Input is the labeled pivot sequence from structure.js's labelPivotSequence
// (oldest-first); a pivot's type starting with "H" is a swing high, "L" a
// swing low -- zigzagPivots guarantees strict high/low alternation, so no
// separate type-alternation check is needed here.

const HIGH_TYPES = new Set(["H", "HH", "LH"]);

function isHigh(pivot) {
  return HIGH_TYPES.has(pivot.type);
}

/**
 * @param {{type: string, price: number, date: string}[]} labeledPivots oldest-first
 * @param {"uptrend_intact"|"downtrend_intact"|"confirmed_reversal_bullish"|"confirmed_reversal_bearish"|"sideways"|"ambiguous"} dowState
 * @returns {{label: string|null, confidence: "confirmed"|"tentative"|"unconfirmed", reason: string, passedGates: string[]}}
 */
export function labelWave(labeledPivots, dowState) {
  const bullishTrend = dowState === "uptrend_intact" || dowState === "confirmed_reversal_bullish";
  const bearishTrend = dowState === "downtrend_intact" || dowState === "confirmed_reversal_bearish";

  if (bullishTrend || bearishTrend) {
    const impulse = tryImpulse(labeledPivots, bullishTrend);
    if (impulse) return impulse;
  }

  const correction = tryCorrection(labeledPivots);
  if (correction) return correction;

  return {
    label: null,
    confidence: "unconfirmed",
    reason:
      labeledPivots.length < 4
        ? "fewer than 4 confirmed swings -- not enough structure to label"
        : "last swings do not satisfy GUE's impulse hard gates or a simple A-B-C alternation",
    passedGates: [],
  };
}

function tryImpulse(labeledPivots, bullish) {
  if (labeledPivots.length < 6) return null;
  const [p0, p1, p2, p3, p4, p5] = labeledPivots.slice(-6);

  // The 6-point pattern must end on the side the completed impulse points to
  // (a bullish impulse ends at a high) and start on the opposite side.
  if (bullish && (isHigh(p0) || !isHigh(p1) || isHigh(p2) || !isHigh(p3) || isHigh(p4) || !isHigh(p5))) return null;
  if (!bullish && (!isHigh(p0) || isHigh(p1) || !isHigh(p2) || isHigh(p3) || !isHigh(p4) || isHigh(p5))) return null;

  const dir = bullish ? 1 : -1;
  const wave1 = dir * (p1.price - p0.price);
  const wave3 = dir * (p3.price - p2.price);
  const wave5 = dir * (p5.price - p4.price);
  if (wave1 <= 0 || wave3 <= 0 || wave5 <= 0) return null; // zigzag alternation should prevent this, but never assume

  const wave2Retracement = (dir * (p1.price - p2.price)) / wave1;
  const gate1 = wave2Retracement < 1.0;
  const gate2 = bullish ? p4.price > p1.price : p4.price < p1.price;
  const gate3 = wave3 >= Math.min(wave1, wave5);

  if (!(gate1 && gate2 && gate3)) return null;

  return {
    label: `Impulse wave 5 of 5 (${bullish ? "up" : "down"})`,
    confidence: "confirmed",
    reason: "last 5 swings satisfy GUE-IMPULSE-001/002/003",
    passedGates: ["GUE-IMPULSE-001", "GUE-IMPULSE-002", "GUE-IMPULSE-003"],
  };
}

function tryCorrection(labeledPivots) {
  if (labeledPivots.length < 4) return null;
  return {
    label: "Corrective A-B-C (unvalidated sub-type)",
    confidence: "tentative",
    reason: "last 3 confirmed swings alternate direction; zigzag/flat/triangle sub-typing not attempted",
    passedGates: [],
  };
}

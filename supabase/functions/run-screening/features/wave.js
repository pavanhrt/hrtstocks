// Best-effort Elliott-wave labeling for the *current* swing sequence --
// determines how far into a valid impulse (or corrective zigzag) the
// trailing pivots go, including whether the current wave is still forming
// (an unconfirmed leg) or already completed, rather than only ever
// recognizing a fully-finished 6-pivot pattern and mislabeling it "wave 5 of
// 5" regardless of where price actually is. Not an attempt at a multi-year,
// primary-degree count, and not sub-wave-typed (no flat/triangle/diagonal
// internal validation) -- AGENTS.md treats full wave counting as
// MANUAL_REVIEW/optional (Phase 3): this module honors that by only ever
// claiming a label when it can point to which documented rule validated it
// and how far the validation actually reached, returning "unconfirmed"
// (never a guess) otherwise.
//
// Hard gates below are copied from strategies/gue.yaml's impulse_rules
// verbatim (ids kept in the output for traceability):
//   GUE-IMPULSE-001  wave_2_retracement_fraction < 1.0
//   GUE-IMPULSE-002  wave 4 does not enter wave 1's price territory
//   GUE-IMPULSE-003  wave_3_length >= min(wave_1_length, wave_5_length)
//
// Input is the labeled pivot sequence from structure.js's labelPivotSequence
// (oldest-first, confirmed only) plus the current unconfirmed leg from
// structure.js's zigzagPivotsWithUnconfirmedLeg -- a pivot's type ending in
// "H" is a swing high, ending in "L" (or exactly "L") a swing low;
// zigzagPivots guarantees strict high/low alternation among confirmed
// pivots, so no separate type-alternation check is needed for them.

const HIGH_TYPES = new Set(["H", "HH", "LH", "EH"]);

function isHigh(pivot) {
  return HIGH_TYPES.has(pivot.type);
}

/**
 * @param {{type: string, price: number, date: string}[]} labeledPivots oldest-first, confirmed only
 * @param {{type: "high"|"low", price: number, date: string}|null} unconfirmedLeg from zigzagPivotsWithUnconfirmedLeg
 * @param {"uptrend_intact"|"downtrend_intact"|"confirmed_reversal_bullish"|"confirmed_reversal_bearish"|"sideways"|"ambiguous"|"manual_review"|"unavailable"} dowState
 * @returns {{primary: object, alternative: object|null}}
 */
export function labelWave(labeledPivots, unconfirmedLeg, dowState) {
  const bullishTrend = dowState === "uptrend_intact" || dowState === "confirmed_reversal_bullish";
  const bearishTrend = dowState === "downtrend_intact" || dowState === "confirmed_reversal_bearish";

  const impulse = bullishTrend || bearishTrend ? tryImpulseProgress(labeledPivots, unconfirmedLeg, bullishTrend) : null;
  const zigzag = tryCorrectiveProgress(labeledPivots, unconfirmedLeg);

  if (impulse && zigzag) return { primary: impulse, alternative: zigzag };
  if (impulse) return { primary: impulse, alternative: null };
  if (zigzag) return { primary: zigzag, alternative: null };

  return {
    primary: {
      structureType: null,
      currentWave: null,
      waveState: null,
      confidence: "unconfirmed",
      reason:
        labeledPivots.length < 2
          ? "fewer than 2 confirmed swings -- not enough structure to label"
          : "trailing swings do not satisfy GUE's impulse hard gates at any length, nor a simple zigzag shape",
      passedGates: [],
      ruleArithmetic: {},
      invalidationPrice: null,
      invalidationCondition: null,
      label: null, // kept for callers still on the pre-hypothesis shape (see direction.js)
    },
    alternative: null,
  };
}

/**
 * Finds the LONGEST trailing window (2-6 confirmed pivots, i.e. up to waves
 * 1-5) that both starts on the correct origin type for `bullish` and
 * satisfies every GUE hard gate checkable at that length -- not just whether
 * a full 6-pivot pattern exists. A longer window that fails is not allowed
 * to hide a valid shorter one (e.g. wave 3 being the shortest only
 * invalidates a claim that wave 5 is done; waves 1-4 may still be a clean,
 * currently-forming-wave-5 count).
 */
function tryImpulseProgress(labeledPivots, unconfirmedLeg, bullish) {
  const maxLen = Math.min(6, labeledPivots.length);
  for (let len = maxLen; len >= 1; len--) {
    const window = labeledPivots.slice(-len);
    const originIsCorrectType = bullish ? !isHigh(window[0]) : isHigh(window[0]);
    if (!originIsCorrectType) continue;

    const check = validateImpulsePrefix(window, bullish);
    if (!check.valid) continue;

    const confirmedWaveCount = len - 1; // window[0] is the origin, not a wave itself
    const legContinues = unconfirmedLeg != null; // walkZigzag guarantees it's the opposite type of the true last confirmed pivot
    if (confirmedWaveCount === 0 && !legContinues) continue; // just an origin pivot with nothing happening yet -- nothing to report
    const isFullImpulse = confirmedWaveCount === 5;

    let currentWave, waveState, confidence;
    if (isFullImpulse) {
      currentWave = "5";
      waveState = "completed";
      confidence = "confirmed";
    } else if (legContinues) {
      currentWave = String(confirmedWaveCount + 1);
      waveState = "forming";
      confidence = "tentative"; // the rules that would confirm this wave can't be checked until it's a real pivot
    } else {
      currentWave = String(confirmedWaveCount);
      waveState = "completed";
      confidence = "tentative"; // valid so far, but no forming leg observed yet -- could be pausing, not necessarily continuing
    }

    return {
      structureType: "impulse",
      currentWave,
      waveState,
      confidence,
      reason: isFullImpulse
        ? "all 5 waves satisfy GUE-IMPULSE-001/002/003"
        : `waves 1-${confirmedWaveCount} satisfy every GUE hard gate checkable so far`,
      passedGates: check.passedGates,
      ruleArithmetic: check.arithmetic,
      invalidationPrice: isFullImpulse ? null : impulseInvalidation(window, bullish, waveState, confirmedWaveCount).price,
      invalidationCondition: isFullImpulse ? null : impulseInvalidation(window, bullish, waveState, confirmedWaveCount).condition,
      label: `Impulse wave ${currentWave} (${bullish ? "up" : "down"}, ${waveState})`,
    };
  }
  return null;
}

/**
 * Validates whatever GUE hard gates apply to a window of this length,
 * returning the actual numbers computed (never just a boolean) so they can
 * be persisted as rule_arithmetic.
 */
function validateImpulsePrefix(window, bullish) {
  const dir = bullish ? 1 : -1;
  const arithmetic = {};
  const passedGates = [];

  if (window.length < 2) return { valid: true, arithmetic, passedGates }; // just the origin confirmed -- nothing to validate yet

  const wave1 = dir * (window[1].price - window[0].price);
  arithmetic.wave1 = wave1;
  if (wave1 <= 0) return { valid: false, arithmetic, passedGates };

  if (window.length >= 3) {
    const wave2Retracement = (dir * (window[1].price - window[2].price)) / wave1;
    arithmetic.wave2RetracementFraction = wave2Retracement;
    if (!(wave2Retracement < 1.0)) return { valid: false, arithmetic, passedGates };
    passedGates.push("GUE-IMPULSE-001");
  }

  let wave3 = null;
  if (window.length >= 4) {
    wave3 = dir * (window[3].price - window[2].price);
    arithmetic.wave3 = wave3;
    if (wave3 <= 0) return { valid: false, arithmetic, passedGates };
  }

  if (window.length >= 5) {
    const noOverlap = bullish ? window[4].price > window[1].price : window[4].price < window[1].price;
    arithmetic.wave4EntersWave1Territory = !noOverlap;
    if (!noOverlap) return { valid: false, arithmetic, passedGates };
    passedGates.push("GUE-IMPULSE-002");
  }

  if (window.length >= 6) {
    const wave5 = dir * (window[5].price - window[4].price);
    arithmetic.wave5 = wave5;
    if (wave5 <= 0) return { valid: false, arithmetic, passedGates };
    const wave3NotShortest = wave3 >= Math.min(wave1, wave5);
    arithmetic.wave3NotShortest = wave3NotShortest;
    if (!wave3NotShortest) return { valid: false, arithmetic, passedGates };
    passedGates.push("GUE-IMPULSE-003");
  }

  return { valid: true, arithmetic, passedGates };
}

/**
 * Only waves 2 and 4 have a hard-rule-derived invalidation level (the same
 * GUE-IMPULSE-001/002 rules that confirm them). Waves 1, 3, 5 forming or any
 * completed-but-not-yet-continuing state have no documented hard-rule
 * invalidation price -- disclosed as such rather than invented.
 */
function impulseInvalidation(window, bullish, waveState, confirmedWaveCount) {
  if (waveState !== "forming") return { price: null, condition: "no documented hard-rule invalidation for a completed, non-forming wave position" };
  const formingWave = confirmedWaveCount + 1;
  if (formingWave === 2) {
    const origin = window[0].price;
    return {
      price: origin,
      condition: `a confirmed close ${bullish ? "below" : "above"} ${origin} would retrace 100%+ of wave 1 (GUE-IMPULSE-001), invalidating this count`,
    };
  }
  if (formingWave === 4) {
    const wave1Top = window[1].price;
    return {
      price: wave1Top,
      condition: `a confirmed close ${bullish ? "below" : "above"} ${wave1Top} would enter wave 1's territory (GUE-IMPULSE-002), invalidating this count`,
    };
  }
  return { price: null, condition: "no documented hard-rule invalidation level for this forming wave (1, 3, or 5)" };
}

/**
 * Validates a trailing origin-A-B-C window as a simple corrective zigzag
 * shape (5-3-5 internal structure is NOT checked -- no sub-wave data at this
 * level): B must not retrace past the origin of A, and C must extend beyond
 * A's own terminus in A's direction. Both are structural/directional
 * requirements of a zigzag's own definition, not invented numeric
 * thresholds. Flat/triangle/combination shapes are not attempted and stay
 * unconfirmed.
 */
function tryCorrectiveProgress(labeledPivots, unconfirmedLeg) {
  if (labeledPivots.length < 3) return null;
  const confirmedLen = Math.min(4, labeledPivots.length);
  const window = labeledPivots.slice(-confirmedLen);
  // window[0]=origin, window[1]=A always confirmed here; B/C may be forming.
  const [origin, a] = window;
  const correctionIsDown = a.price < origin.price;
  const dir = correctionIsDown ? -1 : 1;

  const waveA = dir * (a.price - origin.price);
  if (waveA <= 0) return null; // shouldn't happen given alternation, but never assume

  if (window.length < 3) {
    // Only the origin and A are confirmed -- B may be forming.
    if (!unconfirmedLeg) return null;
    return {
      structureType: "zigzag",
      currentWave: "B",
      waveState: "forming",
      confidence: "tentative",
      reason: "wave A confirmed; wave B is the current forming leg",
      passedGates: [],
      ruleArithmetic: { waveA },
      invalidationPrice: null,
      invalidationCondition: "no documented hard-rule invalidation level for a forming wave B",
      label: "Corrective zigzag, wave B (forming)",
    };
  }

  const b = window[2];
  const bRetracesPastOrigin = correctionIsDown ? b.price > origin.price : b.price < origin.price;
  if (bRetracesPastOrigin) return null; // not a valid zigzag shape

  if (window.length < 4) {
    if (!unconfirmedLeg) {
      return {
        structureType: "zigzag",
        currentWave: "B",
        waveState: "completed",
        confidence: "tentative",
        reason: "waves A and B confirmed, stay within zigzag shape; no forming wave C observed yet",
        passedGates: [],
        ruleArithmetic: { waveA, waveBRetracedPastOrigin: bRetracesPastOrigin },
        invalidationPrice: null,
        invalidationCondition: "no documented hard-rule invalidation level for this position",
        label: "Corrective zigzag, wave B (completed)",
      };
    }
    return {
      structureType: "zigzag",
      currentWave: "C",
      waveState: "forming",
      confidence: "tentative",
      reason: "waves A and B confirmed, stay within zigzag shape; wave C is the current forming leg",
      passedGates: [],
      ruleArithmetic: { waveA, waveBRetracedPastOrigin: bRetracesPastOrigin },
      invalidationPrice: null,
      invalidationCondition: "no documented hard-rule invalidation level for a forming wave C",
      label: "Corrective zigzag, wave C (forming)",
    };
  }

  const c = window[3];
  const cExtendsBeyondA = correctionIsDown ? c.price < a.price : c.price > a.price;
  if (!cExtendsBeyondA) return null; // C failed to extend past A -- not a clean zigzag; stays unconfirmed rather than mislabeled

  return {
    structureType: "zigzag",
    currentWave: "C",
    waveState: "completed",
    confidence: "confirmed",
    reason: "wave B stayed within the origin of wave A, and wave C extended beyond wave A -- a valid zigzag shape",
    passedGates: [],
    ruleArithmetic: { waveA, waveBRetracedPastOrigin: bRetracesPastOrigin, waveCExtendsBeyondA: cExtendsBeyondA },
    invalidationPrice: null,
    invalidationCondition: null,
    label: "Corrective zigzag, wave C (completed)",
  };
}

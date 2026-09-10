// Server-side final_alignment computation (closes problem #1: confluence
// was calculated client-side from 3 dow_state strings only, in
// DirectionTable.tsx's confluenceOf(); closes problem #2: Direction never
// combined SMM + GUE + PAPA evidence -- it only ever called
// classifyDowStructure + labelWave, with no pattern evidence anywhere in the
// pipeline). React never derives this -- it reads
// instrument_alignment.final_alignment once this is wired into persistence.
//
// Design (a disclosed PROJECT_DEFAULT synthesis -- smm-chart-analysis-SKILL.md
// §7 "The verdict" establishes a per-chart weighting (primary trend >
// position vs the trend-defining level > latest structure break > candle
// patterns at the edge of the range > volume) but never defines how to
// combine THREE timeframes' verdicts plus a wave hypothesis plus pattern
// evidence into one instrument-level call -- no source document resolves
// that, so this module's own synthesis is:
//
//   1. SMM (Dow theory) across daily+weekly+monthly is the ONLY thing that
//      can produce a directional call (ALIGNED_BULLISH/ALIGNED_BEARISH) --
//      all three timeframes must independently agree. This is the same
//      requirement the client-side confluenceOf() it replaces already used,
//      now authoritative and evaluated server-side against every timeframe's
//      dow_state.
//   2. GUE (the wave hypothesis) is disclosed alongside the call but never
//      changes it. AGENTS.md already treats Elliott counting as
//      MANUAL_REVIEW-by-design (see wave.js's own framing), and a *confirmed*
//      impulse on a given timeframe can never actually disagree with that
//      timeframe's own dow_state -- both are derived from the very same
//      pivot sequence -- so there is no sound, non-invented basis for GUE to
//      independently veto or confirm a call here.
//   3. PAPA (candlestick + chart-formation patterns) can downgrade an
//      otherwise-aligned call to MANUAL_REVIEW, never flip it outright --
//      matching the source's own "trend outranks patterns" ordering. A
//      TRIGGERED pattern (never a mere OBSERVED one) whose direction opposes
//      the SMM call, on ANY available timeframe, is exactly the "reversal
//      signal" smm-chart-analysis-SKILL.md §1 describes as ending a trend's
//      validity -- real enough to require a human look, not strong enough
//      alone to declare the opposite trend, which is why this stays
//      MANUAL_REVIEW rather than flipping to ALIGNED_(opposite direction).
//   4. Missing timeframe coverage never becomes a directional pass: zero
//      resolved timeframes is UNAVAILABLE; 1-2 resolved timeframes is
//      MANUAL_REVIEW (real but incomplete evidence) -- this never evaluates
//      a directional call against fewer than all 3 timeframes.
//
// ALIGNMENT_LOGIC_VERSION is bumped whenever this synthesis changes, so a
// stored final_alignment can be told apart from one computed under a
// different rule; callers that persist this should store it alongside.

export const ALIGNMENT_LOGIC_VERSION = "1.0.0";

const BULLISH_DOW_STATES = new Set(["uptrend_intact", "confirmed_reversal_bullish"]);
const BEARISH_DOW_STATES = new Set(["downtrend_intact", "confirmed_reversal_bearish"]);
const TIMEFRAMES = ["daily", "weekly", "monthly"];

/**
 * @param {{daily: object|null, weekly: object|null, monthly: object|null}} direction buildDirectionAnalysis's output -- each populated entry has .dowState
 * @param {{daily?: object[], weekly?: object[], monthly?: object[]}} [patternsByTimeframe] pattern_detections-shaped hits (features/patterns.js), grouped by the timeframe they were detected on
 * @returns {{finalAlignment: "ALIGNED_BULLISH"|"ALIGNED_BEARISH"|"SIDEWAYS"|"MIXED"|"MANUAL_REVIEW"|"UNAVAILABLE", reason: string, smmAlignment: "bullish"|"bearish"|"sideways"|"mixed"|null, timeframesAvailable: string[], opposingTriggeredPattern: {timeframe: string, patternName: string, direction: string}|null}}
 */
export function computeFinalAlignment(direction, patternsByTimeframe = {}) {
  const timeframesAvailable = TIMEFRAMES.filter((tf) => direction[tf] != null);

  if (timeframesAvailable.length === 0) {
    return {
      finalAlignment: "UNAVAILABLE",
      reason: "no timeframe has a resolved Dow structure (unresolved zigzag parameter or insufficient bars)",
      smmAlignment: null,
      timeframesAvailable,
      opposingTriggeredPattern: null,
    };
  }
  if (timeframesAvailable.length < TIMEFRAMES.length) {
    return {
      finalAlignment: "MANUAL_REVIEW",
      reason: `only ${timeframesAvailable.join("+")} resolved -- full daily+weekly+monthly confluence cannot be established`,
      smmAlignment: null,
      timeframesAvailable,
      opposingTriggeredPattern: null,
    };
  }

  const dowStates = TIMEFRAMES.map((tf) => direction[tf].dowState);
  const allBullish = dowStates.every((s) => BULLISH_DOW_STATES.has(s));
  const allBearish = dowStates.every((s) => BEARISH_DOW_STATES.has(s));
  const allSideways = dowStates.every((s) => s === "sideways");
  const smmAlignment = allBullish ? "bullish" : allBearish ? "bearish" : allSideways ? "sideways" : "mixed";

  if (smmAlignment === "mixed") {
    return {
      finalAlignment: "MIXED",
      reason: `daily/weekly/monthly Dow structure disagree: ${TIMEFRAMES.map((tf, i) => `${tf}=${dowStates[i]}`).join(", ")}`,
      smmAlignment,
      timeframesAvailable,
      opposingTriggeredPattern: null,
    };
  }
  if (smmAlignment === "sideways") {
    return {
      finalAlignment: "SIDEWAYS",
      reason: "daily, weekly, and monthly are all in a sideways range",
      smmAlignment,
      timeframesAvailable,
      opposingTriggeredPattern: null,
    };
  }

  const opposingDirection = smmAlignment === "bullish" ? "bearish" : "bullish";
  const opposingTriggeredPattern = findOpposingTriggeredPattern(patternsByTimeframe, opposingDirection);
  if (opposingTriggeredPattern) {
    return {
      finalAlignment: "MANUAL_REVIEW",
      reason: `daily+weekly+monthly Dow structure is aligned ${smmAlignment}, but a TRIGGERED ${opposingTriggeredPattern.patternName} (${opposingTriggeredPattern.timeframe}) opposes it -- needs a human look before treating this as ALIGNED_${smmAlignment === "bullish" ? "BULLISH" : "BEARISH"}`,
      smmAlignment,
      timeframesAvailable,
      opposingTriggeredPattern,
    };
  }

  return {
    finalAlignment: smmAlignment === "bullish" ? "ALIGNED_BULLISH" : "ALIGNED_BEARISH",
    reason: `daily, weekly, and monthly Dow structure all confirm a ${smmAlignment} trend with no opposing triggered pattern`,
    smmAlignment,
    timeframesAvailable,
    opposingTriggeredPattern: null,
  };
}

function findOpposingTriggeredPattern(patternsByTimeframe, opposingDirection) {
  for (const timeframe of TIMEFRAMES) {
    const hits = patternsByTimeframe[timeframe] ?? [];
    const hit = hits.find((h) => h.state === "TRIGGERED" && h.direction === opposingDirection);
    if (hit) return { timeframe, patternName: hit.patternName, direction: hit.direction };
  }
  return null;
}

// Synthesizes the swing (Weekly->Daily->1H) mandatory-gate trace subset
// (strategies/buy-swing.yaml's WBP-*, sell-swing.yaml's WSP-*) into one
// swing_analysis_results-shaped row per hypothesis -- bullish and bearish
// are always separate rows, never pooled (closes problem #15: a bearish-side
// failure can never reject the bullish row, because they're different rows).
//
// This is deliberately the ONLY thing this module can honestly compute
// today. WBP-M5..M8/WSP-S5..S8 (hourly Elliott setup, PAPA trigger, SMM
// Hat, reward/risk) are MANUAL_REVIEW sentinels -- see buy-swing.yaml's own
// notes: blocked on 1-hour bar ingestion, architecture-plan.md Phase 2
// REMAINING. Without those, route selection (BUY-1..5/SELL-1..5),
// confirmation groups, vetoes, and reward/risk cannot be computed without
// inventing an hourly entry/stop/target this pipeline has no real data for.
// final_action is therefore always 'WAIT' here -- never a guessed BUY/SELL --
// with the specific reason disclosed in pending_conditions, not silently
// omitted.

const GATE_PREFIX = { bullish: "WBP-", bearish: "WSP-" };
const DIRECTION_LOCK_GATE_COUNT = 4; // M1-M4 / S1-S4

function gateNumber(ruleId) {
  const match = ruleId.match(/(\d+)$/);
  return match ? Number(match[1]) : null;
}

/**
 * @param {"bullish"|"bearish"} hypothesis
 * @param {{rule_id: string, result: string, explanation: string}[]} traces the full pooled traces array for one instrument/run (evaluateRules() output, every active strategy) -- this filters to its own WBP-/WSP- prefix
 * @returns {object|null} a swing_analysis_results-shaped row (camelCase, caller maps to columns), or null when none of this hypothesis's swing gates were evaluated (buy-swing.yaml/sell-swing.yaml not yet seeded/active -- nothing to report, not NO_DATA)
 */
export function evaluateSwingHypothesis(hypothesis, traces) {
  const prefix = GATE_PREFIX[hypothesis];
  const gateTraces = traces.filter((t) => t.rule_id.startsWith(prefix));
  if (gateTraces.length === 0) return null;

  const mandatoryGates = {};
  for (const t of gateTraces) mandatoryGates[t.rule_id] = t.result;

  const directionLockGates = gateTraces.filter((t) => (gateNumber(t.rule_id) ?? 99) <= DIRECTION_LOCK_GATE_COUNT);
  const failedDirectionLockGates = directionLockGates.filter((t) => t.result === "FAIL");
  const noDataDirectionLockGates = directionLockGates.filter((t) => t.result === "NO_DATA");
  const manualReviewGates = gateTraces.filter((t) => t.result === "MANUAL_REVIEW");

  const pendingConditions = [];
  for (const t of failedDirectionLockGates) pendingConditions.push(`${t.rule_id} FAILed: ${t.explanation}`);
  for (const t of noDataDirectionLockGates) pendingConditions.push(`${t.rule_id}: insufficient data to evaluate`);
  if (manualReviewGates.length > 0) {
    pendingConditions.push(
      `${manualReviewGates.map((t) => t.rule_id).join(", ")} not yet automatable: 1-hour bar ingestion is not implemented (architecture-plan.md Phase 2 REMAINING)`
    );
  }
  pendingConditions.push(
    "Route selection, the 5 confirmation groups, vetoes, and reward/risk are not computed by this module yet -- see architecture-plan.md Phase 4 REMAINING"
  );

  let dataQuality;
  if (directionLockGates.length < DIRECTION_LOCK_GATE_COUNT) {
    dataQuality = "PARTIAL"; // shouldn't happen once seeded correctly -- disclosed rather than assumed complete
  } else if (noDataDirectionLockGates.length === DIRECTION_LOCK_GATE_COUNT) {
    dataQuality = "NO_DATA";
  } else if (noDataDirectionLockGates.length > 0) {
    dataQuality = "PARTIAL";
  } else {
    dataQuality = "PASS"; // all 4 direction-lock gates resolved to a real PASS/FAIL -- data was sufficient, regardless of the verdict
  }

  return {
    hypothesis,
    selectedRoute: null,
    mandatoryGates,
    confirmationGroups: {},
    confirmationGroupsPassed: 0,
    vetoes: [],
    pendingConditions,
    entryPrice: null,
    structuralStop: null,
    conservativeTarget: null,
    risk: null,
    reward: null,
    rewardRiskRatio: null,
    finalAction: "WAIT", // never BUY/SELL until WBP-M5..M8/WSP-S5..S8 are real gates
    dataQuality,
  };
}

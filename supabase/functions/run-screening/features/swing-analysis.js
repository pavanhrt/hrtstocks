// Synthesizes the swing (Weekly->Daily->1H) mandatory-gate trace subset
// (strategies/buy-swing.yaml's WBP-*, sell-swing.yaml's WSP-*) plus the
// hourly M5-M8 evidence this cycle's own modules compute
// (features/hourly-routes.js, papa-formations.js, smm-hat.js,
// reward-risk.js, confirmation-groups.js, swing-vetoes.js) into one
// swing_analysis_results-shaped row per hypothesis -- bullish and bearish
// are always separate rows, never pooled (closes problem #15: a bearish-side
// failure can never reject the bullish row, because they're different rows).
//
// WBP-M1..M4/WSP-S1..S4 (the weekly+daily direction lock) come from the
// pooled rule-trace array (`traces`), same as before. WBP-M5..M8/WSP-S5..S8
// do NOT flow through that same YAML/rule-engine path -- they depend on
// per-instrument hourly bars fetched conditionally, which does not fit the
// batch buildFeatureContext()+evaluateRules() pipeline M1-M4 use (their own
// YAML `expression: manual_review` stub stays exactly that; see
// buy-swing.yaml/sell-swing.yaml's own notes on WBP-M5..M8). Real M5-M8
// evidence is computed directly by index.ts and passed into this function as
// `evidence`, the same pattern already established for M5's own
// `route_evidence`/`adxCondition` before this cycle.
//
// finalAction is BUY/SELL only when ALL EIGHT gates (M1-M4 from traces,
// M5-M8 from evidence) pass, AND at least 4 of the 5 confirmation groups are
// supportive, AND zero vetoes fired -- never a guess, and every blocking
// reason is named in pendingConditions rather than left as a bare WAIT.

const GATE_PREFIX = { bullish: "WBP-", bearish: "WSP-" };
const DIRECTION_LOCK_GATE_COUNT = 4; // M1-M4 / S1-S4

function gateNumber(ruleId) {
  const match = ruleId.match(/(\d+)$/);
  return match ? Number(match[1]) : null;
}

/**
 * True only when this hypothesis's 4 direction-lock gates (M1-M4/S1-S4) were
 * all evaluated and all PASSed -- both playbooks' own explicit rule ("M1 AND
 * M2 AND M3 AND M4 must all pass before the hourly chart is opened").
 * index.js uses this to gate 1-hour bar ingestion: fetching hourly data for
 * an instrument whose weekly+daily direction lock hasn't even cleared would
 * be wasted Fyers request budget on a stock the playbook itself says isn't
 * ready for the hourly chart yet.
 * @param {"bullish"|"bearish"} hypothesis
 * @param {{rule_id: string, result: string}[]} traces
 */
export function directionLockPassed(hypothesis, traces) {
  const prefix = GATE_PREFIX[hypothesis];
  const directionLockGates = traces.filter((t) => t.rule_id.startsWith(prefix) && (gateNumber(t.rule_id) ?? 99) <= DIRECTION_LOCK_GATE_COUNT);
  return directionLockGates.length === DIRECTION_LOCK_GATE_COUNT && directionLockGates.every((t) => t.result === "PASS");
}

/**
 * @param {"bullish"|"bearish"} hypothesis
 * @param {{rule_id: string, result: string, explanation: string}[]} traces the full pooled traces array for one instrument/run (evaluateRules() output, every active strategy) -- this filters to its own WBP-/WSP- prefix
 * @param {object} [evidence] real M5-M8 evidence, all optional/independently nullable -- a missing piece degrades that specific gate to "not yet resolved," never a guessed pass
 * @param {{adx: number, plusDI: number, minusDI: number, slope: string|null, wait: boolean, reason: string|null}|null} [evidence.adxCondition] features/hourly-conditions.js#evaluateHourlyAdxCondition's result -- combination-matrix evidence only, never gates finalAction directly (see hourly-conditions.js's own header comment)
 * @param {object|null} [evidence.selectedRoute] whichever features/hourly-routes.js detector's result had requiredChecksPassed===true, or null
 * @param {boolean} [evidence.papaFormationTriggered] whether any M6 PAPA formation (features/papa-formations.js) TRIGGERED same-direction this run
 * @param {object|null} [evidence.smmHat] features/smm-hat.js#evaluateSmmHat's result, or null
 * @param {object|null} [evidence.rewardRisk] features/reward-risk.js#computeRewardRisk's result, or null
 * @param {{groups: object, passedCount: number, passed: boolean}|null} [evidence.confirmationGroups] features/confirmation-groups.js#evaluateConfirmationGroups's result, or null
 * @param {object[]} [evidence.vetoes] features/swing-vetoes.js#evaluateSwingVetoes's result, defaults to []
 * @returns {object|null} a swing_analysis_results-shaped row (camelCase, caller maps to columns), or null when none of this hypothesis's swing gates were evaluated (buy-swing.yaml/sell-swing.yaml not yet seeded/active -- nothing to report, not NO_DATA)
 */
export function evaluateSwingHypothesis(hypothesis, traces, evidence = {}) {
  const { adxCondition = null, selectedRoute = null, papaFormationTriggered = false, smmHat = null, rewardRisk = null, confirmationGroups = null, vetoes = [] } = evidence;

  const prefix = GATE_PREFIX[hypothesis];
  const gateTraces = traces.filter((t) => t.rule_id.startsWith(prefix));
  if (gateTraces.length === 0) return null;

  const mandatoryGates = {};
  for (const t of gateTraces) mandatoryGates[t.rule_id] = t.result;

  const directionLockGates = gateTraces.filter((t) => (gateNumber(t.rule_id) ?? 99) <= DIRECTION_LOCK_GATE_COUNT);
  const failedDirectionLockGates = directionLockGates.filter((t) => t.result === "FAIL");
  const noDataDirectionLockGates = directionLockGates.filter((t) => t.result === "NO_DATA");
  const directionLockOk = directionLockGates.length === DIRECTION_LOCK_GATE_COUNT && directionLockGates.every((t) => t.result === "PASS");

  const pendingConditions = [];
  for (const t of failedDirectionLockGates) pendingConditions.push(`${t.rule_id} FAILed: ${t.explanation}`);
  for (const t of noDataDirectionLockGates) pendingConditions.push(`${t.rule_id}: insufficient data to evaluate`);

  // M5 (hourly Elliott setup). Only 4 of the 10 documented routes are
  // implemented (BUY-1/SELL-3, BUY-4/SELL-4, SELL-1) -- a non-match is
  // therefore never treated as "M5 fails," only "M5 not yet confirmed by an
  // implemented route," and is disclosed as such.
  const m5Passed = Boolean(selectedRoute?.requiredChecksPassed);
  if (!m5Passed) {
    pendingConditions.push(
      selectedRoute
        ? `M5/S5: ${selectedRoute.route} detected (${selectedRoute.state}) but its required checks are not all confirmed yet`
        : "M5/S5: no implemented hourly route (of BUY-1/BUY-4/SELL-1/SELL-3/SELL-4) has matched this run -- a non-match does not rule out an unimplemented route (BUY-2/BUY-3/BUY-5/SELL-2/SELL-5)"
    );
  }

  // M6 (PAPA price-action trigger, hourly).
  if (!papaFormationTriggered) {
    pendingConditions.push("M6/S6: no implemented PAPA formation has TRIGGERED same-direction this run (see papa-formations.js's own scope note for the formations not yet covered)");
  }

  // M7 (SMM Bull/Bear Hat).
  const wantHat = hypothesis === "bullish" ? "BUY" : "SELL";
  const m7Passed = smmHat?.hat === wantHat;
  if (!m7Passed) {
    pendingConditions.push(smmHat ? `M7/S7: no hat (Step 1: ${smmHat.step1.reading ?? "null"}, Step 2: ${smmHat.step2.reading ?? "null"}) -- both steps must agree` : "M7/S7: not yet computed (no hourly bars)");
  }

  // M8 (reward:risk, strict > 3).
  const m8Passed = Boolean(rewardRisk?.passes);
  if (!m8Passed) {
    pendingConditions.push(
      rewardRisk
        ? `M8/S8: reward:risk ${rewardRisk.rewardRiskRatio != null ? rewardRisk.rewardRiskRatio.toFixed(2) : "n/a"} does not strictly clear the threshold`
        : "M8/S8: not yet computable -- no route with both a structural stop and a computed target"
    );
  }

  // Confirmation groups (>=4 of 5), applied only after all 8 mandatory gates
  // and the selected route already pass, per the cross-check documents' own
  // sequencing (swing-strategy-extraction.md §5).
  const groupsPassed = Boolean(confirmationGroups?.passed);
  if (confirmationGroups && !groupsPassed) {
    pendingConditions.push(`Confirmation groups: only ${confirmationGroups.passedCount}/5 supportive (>=4 required)`);
  }

  // Vetoes -- any single one kills an otherwise-live signal.
  for (const v of vetoes) pendingConditions.push(`Veto (${v.id}): ${v.reason}`);

  // Combination-matrix ADX WAIT condition (swing-strategy-extraction.md §13
  // conflict #4, resolved -- see hourly-conditions.js's header comment).
  // Disclosed either way so a viewer never has to wonder whether ADX was
  // checked at all; folded into finalAction via the vetoes/groups path
  // above where relevant (participationAndRegime), not gated separately
  // here a second time.
  if (adxCondition) {
    pendingConditions.push(
      adxCondition.wait
        ? `Combination-matrix ADX condition says WAIT: ${adxCondition.reason} (swing-specific threshold, swing-strategy-extraction.md §13 conflict #4)`
        : `Combination-matrix ADX condition does not block entry: hourly ADX ${adxCondition.adx.toFixed(2)}, slope ${adxCondition.slope}`
    );
  }

  const allGatesPassed = directionLockOk && m5Passed && papaFormationTriggered && m7Passed && m8Passed;
  const finalAction = allGatesPassed && groupsPassed && vetoes.length === 0 ? wantHat : "WAIT";

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
    selectedRoute: selectedRoute?.route ?? null,
    mandatoryGates,
    confirmationGroups: confirmationGroups?.groups ?? {},
    confirmationGroupsPassed: confirmationGroups?.passedCount ?? 0,
    vetoes,
    combinationMatrix: adxCondition ? { adxCondition } : {},
    pendingConditions,
    entryPrice: rewardRisk?.entryPrice ?? null,
    structuralStop: rewardRisk?.structuralStop ?? null,
    conservativeTarget: rewardRisk?.conservativeTarget ?? null,
    risk: rewardRisk?.risk ?? null,
    reward: rewardRisk?.reward ?? null,
    rewardRiskRatio: rewardRisk?.rewardRiskRatio ?? null,
    finalAction,
    dataQuality,
  };
}

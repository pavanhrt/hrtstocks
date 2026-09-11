import { test } from "node:test";
import assert from "node:assert/strict";
import { evaluateSwingHypothesis, directionLockPassed } from "./swing-analysis.js";

function trace(rule_id, result, explanation = `${rule_id} evaluated to ${result}`) {
  return { rule_id, result, explanation, observed_values: {}, thresholds: {}, source_locator: null };
}

function fullBullishGateSet({ m1 = "PASS", m2 = "PASS", m3 = "PASS", m4 = "PASS" } = {}) {
  return [
    trace("WBP-M1", m1),
    trace("WBP-M2", m2),
    trace("WBP-M3", m3),
    trace("WBP-M4", m4),
    trace("WBP-M5", "MANUAL_REVIEW"),
    trace("WBP-M6", "MANUAL_REVIEW"),
    trace("WBP-M7", "MANUAL_REVIEW"),
    trace("WBP-M8", "MANUAL_REVIEW"),
  ];
}

const FULLY_SUPPORTIVE_EVIDENCE = {
  selectedRoute: { route: "BUY-1", requiredChecksPassed: true },
  papaFormationTriggered: true,
  smmHat: { hat: "BUY", step1: { reading: "BUY" }, step2: { reading: "BUY" } },
  rewardRisk: { entryPrice: 123, structuralStop: 100, conservativeTarget: 150, risk: 23, reward: 27, rewardRiskRatio: 1.17, passes: true },
  confirmationGroups: { groups: {}, passedCount: 5, passed: true },
  vetoes: [],
};

test("evaluateSwingHypothesis returns null when none of this hypothesis's gates were evaluated (strategy not seeded/active)", () => {
  const traces = [trace("SMM-TREND-001", "PASS"), trace("BSP-M1", "PASS")];
  assert.equal(evaluateSwingHypothesis("bullish", traces), null);
  assert.equal(evaluateSwingHypothesis("bearish", traces), null);
});

test("evaluateSwingHypothesis: M1-M4 pass but no M5-M8 evidence supplied -- stays WAIT, discloses each missing gate", () => {
  const result = evaluateSwingHypothesis("bullish", fullBullishGateSet());
  assert.equal(result.finalAction, "WAIT");
  assert.equal(result.dataQuality, "PASS");
  assert.equal(result.selectedRoute, null);
  assert.equal(result.rewardRiskRatio, null);
  assert.ok(result.pendingConditions.some((p) => p.startsWith("M5/S5:")));
  assert.ok(result.pendingConditions.some((p) => p.startsWith("M6/S6:")));
  assert.ok(result.pendingConditions.some((p) => p.startsWith("M7/S7:")));
  assert.ok(result.pendingConditions.some((p) => p.startsWith("M8/S8:")));
});

test("evaluateSwingHypothesis: every gate + confirmation groups supportive + zero vetoes -- a real BUY, finally", () => {
  const result = evaluateSwingHypothesis("bullish", fullBullishGateSet(), FULLY_SUPPORTIVE_EVIDENCE);
  assert.equal(result.finalAction, "BUY");
  assert.equal(result.selectedRoute, "BUY-1");
  assert.equal(result.rewardRiskRatio, 1.17);
  assert.equal(result.entryPrice, 123);
});

test("evaluateSwingHypothesis: the bearish mirror reaches SELL the same way", () => {
  const traces = [
    trace("WSP-S1", "PASS"),
    trace("WSP-S2", "PASS"),
    trace("WSP-S3", "PASS"),
    trace("WSP-S4", "PASS"),
    trace("WSP-S5", "MANUAL_REVIEW"),
    trace("WSP-S6", "MANUAL_REVIEW"),
    trace("WSP-S7", "MANUAL_REVIEW"),
    trace("WSP-S8", "MANUAL_REVIEW"),
  ];
  const evidence = { ...FULLY_SUPPORTIVE_EVIDENCE, selectedRoute: { route: "SELL-3", requiredChecksPassed: true }, smmHat: { hat: "SELL", step1: { reading: "SELL" }, step2: { reading: "SELL" } } };
  const result = evaluateSwingHypothesis("bearish", traces, evidence);
  assert.equal(result.finalAction, "SELL");
});

test("evaluateSwingHypothesis: M1-M4 direction lock failing still blocks finalAction even when every hourly gate is otherwise supportive", () => {
  const result = evaluateSwingHypothesis("bullish", fullBullishGateSet({ m3: "FAIL" }), FULLY_SUPPORTIVE_EVIDENCE);
  assert.equal(result.finalAction, "WAIT");
  assert.ok(result.pendingConditions.some((p) => p.startsWith("WBP-M3 FAILed")));
});

test("evaluateSwingHypothesis: M5 route not confirmed blocks finalAction alone, even with every other gate supportive", () => {
  const evidence = { ...FULLY_SUPPORTIVE_EVIDENCE, selectedRoute: null };
  const result = evaluateSwingHypothesis("bullish", fullBullishGateSet(), evidence);
  assert.equal(result.finalAction, "WAIT");
  assert.ok(result.pendingConditions.some((p) => p.startsWith("M5/S5:")));
});

test("evaluateSwingHypothesis: M6 (no PAPA trigger) blocks finalAction alone", () => {
  const evidence = { ...FULLY_SUPPORTIVE_EVIDENCE, papaFormationTriggered: false };
  const result = evaluateSwingHypothesis("bullish", fullBullishGateSet(), evidence);
  assert.equal(result.finalAction, "WAIT");
  assert.ok(result.pendingConditions.some((p) => p.startsWith("M6/S6:")));
});

test("evaluateSwingHypothesis: M7 (no hat -- Step 1/Step 2 disagree) blocks finalAction alone", () => {
  const evidence = { ...FULLY_SUPPORTIVE_EVIDENCE, smmHat: { hat: "no hat", step1: { reading: "BUY" }, step2: { reading: null } } };
  const result = evaluateSwingHypothesis("bullish", fullBullishGateSet(), evidence);
  assert.equal(result.finalAction, "WAIT");
  assert.ok(result.pendingConditions.some((p) => p.startsWith("M7/S7:")));
});

test("evaluateSwingHypothesis: M8 (reward:risk doesn't clear the strict threshold) blocks finalAction alone", () => {
  const evidence = { ...FULLY_SUPPORTIVE_EVIDENCE, rewardRisk: { ...FULLY_SUPPORTIVE_EVIDENCE.rewardRisk, rewardRiskRatio: 2.5, passes: false } };
  const result = evaluateSwingHypothesis("bullish", fullBullishGateSet(), evidence);
  assert.equal(result.finalAction, "WAIT");
  assert.ok(result.pendingConditions.some((p) => p.startsWith("M8/S8:")));
});

test("evaluateSwingHypothesis: fewer than 4 of 5 confirmation groups blocks finalAction even with all 8 gates passing", () => {
  const evidence = { ...FULLY_SUPPORTIVE_EVIDENCE, confirmationGroups: { groups: {}, passedCount: 3, passed: false } };
  const result = evaluateSwingHypothesis("bullish", fullBullishGateSet(), evidence);
  assert.equal(result.finalAction, "WAIT");
  assert.ok(result.pendingConditions.some((p) => p.includes("only 3/5 supportive")));
});

test("evaluateSwingHypothesis: a single veto kills an otherwise fully-passing signal", () => {
  const evidence = { ...FULLY_SUPPORTIVE_EVIDENCE, vetoes: [{ id: "gap-only-break", reason: "the trigger close registered only on the overnight gap", locator: "x" }] };
  const result = evaluateSwingHypothesis("bullish", fullBullishGateSet(), evidence);
  assert.equal(result.finalAction, "WAIT");
  assert.ok(result.pendingConditions.some((p) => p.includes("Veto (gap-only-break)")));
  assert.deepEqual(result.vetoes, evidence.vetoes);
});

test("evaluateSwingHypothesis captures every mandatory gate's result, M1-M8, in mandatory_gates (from the pooled trace array, unaffected by the new evidence-driven finalAction)", () => {
  const result = evaluateSwingHypothesis("bullish", fullBullishGateSet(), FULLY_SUPPORTIVE_EVIDENCE);
  assert.deepEqual(result.mandatoryGates, {
    "WBP-M1": "PASS",
    "WBP-M2": "PASS",
    "WBP-M3": "PASS",
    "WBP-M4": "PASS",
    "WBP-M5": "MANUAL_REVIEW",
    "WBP-M6": "MANUAL_REVIEW",
    "WBP-M7": "MANUAL_REVIEW",
    "WBP-M8": "MANUAL_REVIEW",
  });
});

test("evaluateSwingHypothesis: dataQuality is PARTIAL when some direction-lock gates are NO_DATA, NO_DATA when all four are", () => {
  const partial = evaluateSwingHypothesis("bullish", fullBullishGateSet({ m2: "NO_DATA" }));
  assert.equal(partial.dataQuality, "PARTIAL");
  assert.ok(partial.pendingConditions.some((p) => p === "WBP-M2: insufficient data to evaluate"));

  const allNoData = evaluateSwingHypothesis("bullish", fullBullishGateSet({ m1: "NO_DATA", m2: "NO_DATA", m3: "NO_DATA", m4: "NO_DATA" }));
  assert.equal(allNoData.dataQuality, "NO_DATA");
});

test("evaluateSwingHypothesis handles the bearish hypothesis independently from the bullish one (never pooled)", () => {
  const traces = [
    ...fullBullishGateSet({ m1: "FAIL" }),
    trace("WSP-S1", "PASS"),
    trace("WSP-S2", "PASS"),
    trace("WSP-S3", "PASS"),
    trace("WSP-S4", "PASS"),
    trace("WSP-S5", "MANUAL_REVIEW"),
    trace("WSP-S6", "MANUAL_REVIEW"),
    trace("WSP-S7", "MANUAL_REVIEW"),
    trace("WSP-S8", "MANUAL_REVIEW"),
  ];
  const bullish = evaluateSwingHypothesis("bullish", traces);
  const bearish = evaluateSwingHypothesis("bearish", traces);
  assert.ok(bullish.pendingConditions.some((p) => p.startsWith("WBP-M1 FAILed")));
  assert.equal(bearish.dataQuality, "PASS");
  assert.equal(bearish.pendingConditions.some((p) => p.includes("FAILed")), false);
});

test("directionLockPassed is true only when all 4 direction-lock gates PASS", () => {
  assert.equal(directionLockPassed("bullish", fullBullishGateSet()), true);
  assert.equal(directionLockPassed("bullish", fullBullishGateSet({ m3: "FAIL" })), false);
  assert.equal(directionLockPassed("bullish", fullBullishGateSet({ m2: "NO_DATA" })), false);
});

test("directionLockPassed is false when the hypothesis's gates were never evaluated at all (strategy not seeded)", () => {
  assert.equal(directionLockPassed("bullish", []), false);
  assert.equal(directionLockPassed("bearish", fullBullishGateSet()), false); // only WBP- traces present, no WSP-
});

test("directionLockPassed does not require the hourly gates (M5-M8) to have resolved -- only M1-M4", () => {
  const traces = fullBullishGateSet(); // M5-M8 are MANUAL_REVIEW in this fixture
  assert.equal(directionLockPassed("bullish", traces), true);
});

test("evaluateSwingHypothesis omits any combination-matrix disclosure when no ADX condition is supplied (unchanged default behavior)", () => {
  const result = evaluateSwingHypothesis("bullish", fullBullishGateSet());
  assert.deepEqual(result.combinationMatrix, {});
  assert.equal(result.pendingConditions.some((p) => p.includes("Combination-matrix ADX")), false);
});

test("evaluateSwingHypothesis discloses a WAIT combination-matrix ADX condition without changing finalAction on its own (still gated by the other 7 checks)", () => {
  const adxCondition = { adx: 11.2, plusDI: 20, minusDI: 15, slope: "flat", wait: true, reason: "hourly ADX 11.20 < 14" };
  const result = evaluateSwingHypothesis("bullish", fullBullishGateSet(), { adxCondition });
  assert.equal(result.finalAction, "WAIT");
  assert.deepEqual(result.combinationMatrix, { adxCondition });
  assert.ok(result.pendingConditions.some((p) => p.includes("WAIT: hourly ADX 11.20 < 14")));
});

test("evaluateSwingHypothesis discloses a non-blocking combination-matrix ADX condition too, not just a waiting one", () => {
  const adxCondition = { adx: 32.5, plusDI: 30, minusDI: 10, slope: "rising", wait: false, reason: null };
  const result = evaluateSwingHypothesis("bullish", fullBullishGateSet(), { adxCondition });
  assert.ok(result.pendingConditions.some((p) => p.includes("does not block entry: hourly ADX 32.50, slope rising")));
});

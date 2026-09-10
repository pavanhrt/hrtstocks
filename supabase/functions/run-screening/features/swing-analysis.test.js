import { test } from "node:test";
import assert from "node:assert/strict";
import { evaluateSwingHypothesis } from "./swing-analysis.js";

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

test("evaluateSwingHypothesis returns null when none of this hypothesis's gates were evaluated (strategy not seeded/active)", () => {
  const traces = [trace("SMM-TREND-001", "PASS"), trace("BSP-M1", "PASS")];
  assert.equal(evaluateSwingHypothesis("bullish", traces), null);
  assert.equal(evaluateSwingHypothesis("bearish", traces), null);
});

test("evaluateSwingHypothesis is always WAIT even when M1-M4 all PASS, disclosing exactly why in pending_conditions", () => {
  const result = evaluateSwingHypothesis("bullish", fullBullishGateSet());
  assert.equal(result.finalAction, "WAIT");
  assert.equal(result.dataQuality, "PASS");
  assert.equal(result.selectedRoute, null);
  assert.equal(result.rewardRiskRatio, null);
  assert.ok(result.pendingConditions.some((p) => p.includes("WBP-M5, WBP-M6, WBP-M7, WBP-M8")));
  assert.ok(result.pendingConditions.some((p) => p.includes("1-hour bar ingestion is not implemented")));
});

test("evaluateSwingHypothesis captures every mandatory gate's result, M1-M8, in mandatory_gates", () => {
  const result = evaluateSwingHypothesis("bullish", fullBullishGateSet());
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

test("evaluateSwingHypothesis surfaces a FAILed direction-lock gate in pending_conditions but still returns WAIT, not a rejection state", () => {
  const result = evaluateSwingHypothesis("bullish", fullBullishGateSet({ m3: "FAIL" }));
  assert.equal(result.finalAction, "WAIT");
  assert.ok(result.pendingConditions.some((p) => p.startsWith("WBP-M3 FAILed")));
});

test("evaluateSwingHypothesis: dataQuality is PARTIAL when some direction-lock gates are NO_DATA, NO_DATA when all four are", () => {
  const partial = evaluateSwingHypothesis("bullish", fullBullishGateSet({ m2: "NO_DATA" }));
  assert.equal(partial.dataQuality, "PARTIAL");
  assert.ok(partial.pendingConditions.some((p) => p === "WBP-M2: insufficient data to evaluate"));

  const allNoData = evaluateSwingHypothesis(
    "bullish",
    fullBullishGateSet({ m1: "NO_DATA", m2: "NO_DATA", m3: "NO_DATA", m4: "NO_DATA" })
  );
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

test("evaluateSwingHypothesis never claims BUY or SELL -- finalAction is always WAIT regardless of gate outcomes", () => {
  const allFail = evaluateSwingHypothesis("bullish", fullBullishGateSet({ m1: "FAIL", m2: "FAIL", m3: "FAIL", m4: "FAIL" }));
  assert.equal(allFail.finalAction, "WAIT");
  const allPass = evaluateSwingHypothesis("bullish", fullBullishGateSet());
  assert.equal(allPass.finalAction, "WAIT");
});

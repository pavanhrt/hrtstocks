import { test } from "node:test";
import assert from "node:assert/strict";
import { evaluateRule, evaluateRules } from "./evaluate.js";

const smmRr001 = {
  rule_id: "SMM-RR-001",
  name: "Minimum reward-risk",
  expression: "risk > 0 and reward / risk >= minimum_reward_risk",
  inputs: ["reward", "risk"],
  parameters: ["minimum_reward_risk"],
  true_result: "PASS",
  false_result: "FAIL",
  missing_result: "NO_DATA",
  hard_gate: true,
  source_status: "DOCUMENTED",
};

test("evaluateRule: normal pass", () => {
  const { result, explanation } = evaluateRule(smmRr001, { reward: 30, risk: 10 }, { minimum_reward_risk: 3 });
  assert.equal(result, "PASS");
  assert.match(explanation, /evaluated to true/);
});

test("evaluateRule: normal fail", () => {
  const { result } = evaluateRule(smmRr001, { reward: 10, risk: 10 }, { minimum_reward_risk: 3 });
  assert.equal(result, "FAIL");
});

test("evaluateRule: missing input maps to missing_result, not a guess", () => {
  const { result, explanation } = evaluateRule(smmRr001, { reward: null, risk: 10 }, { minimum_reward_risk: 3 });
  assert.equal(result, "NO_DATA");
  assert.match(explanation, /missing input/);
});

test("evaluateRule: unresolved parameter maps to missing_result without guessing a default", () => {
  const { result, explanation } = evaluateRule(smmRr001, { reward: 30, risk: 10 }, { minimum_reward_risk: null });
  assert.equal(result, "NO_DATA");
  assert.match(explanation, /unresolved parameter/);
});

test("evaluateRule: manual_review sentinel never reaches the expression engine", () => {
  const rule = {
    rule_id: "PAPA-DOW-003",
    name: "Advanced Dow intermediate levels",
    expression: "manual_review",
    source_status: "UNRESOLVED",
    true_result: "MANUAL_REVIEW",
    false_result: "MANUAL_REVIEW",
    missing_result: "MANUAL_REVIEW",
    inputs: [],
    parameters: [],
  };
  const { result, explanation } = evaluateRule(rule, {}, {});
  assert.equal(result, "MANUAL_REVIEW");
  assert.match(explanation, /requiring manual review/);
});

test("evaluateRules: a failed hard gate is recorded in failedGates", () => {
  const { traces, failedGates } = evaluateRules(
    [smmRr001],
    { reward: 5, risk: 10 },
    { minimum_reward_risk: 3 }
  );
  assert.equal(traces[0].result, "FAIL");
  assert.deepEqual(failedGates, ["SMM-RR-001"]);
});

test("evaluateRules: a passed hard gate is not recorded as failed", () => {
  const { failedGates } = evaluateRules([smmRr001], { reward: 30, risk: 10 }, { minimum_reward_risk: 3 });
  assert.deepEqual(failedGates, []);
});

test("evaluateRules: a non-hard-gate rule never contributes to failedGates even on FAIL", () => {
  const soft = { ...smmRr001, hard_gate: false };
  const { failedGates } = evaluateRules([soft], { reward: 1, risk: 10 }, { minimum_reward_risk: 3 });
  assert.deepEqual(failedGates, []);
});

// Regression coverage for the classification-architecture fix: a hard gate
// whose false_result is WATCH (e.g. SMM-TWR-001/002) or whose missing_result
// is MANUAL_REVIEW/NO_DATA (e.g. GUE-IMPULSE-001/002/003 when their wave
// arithmetic isn't computed) must never reject the instrument -- only a
// literal FAIL may.
const smmTwr001 = {
  rule_id: "SMM-TWR-001",
  name: "Bullish Tide-Wave alignment",
  expression: "tide_macd_slope == 'rising'",
  inputs: ["tide_macd_slope"],
  parameters: [],
  true_result: "PASS",
  false_result: "WATCH",
  missing_result: "NO_DATA",
  hard_gate: true,
  source_status: "DOCUMENTED",
};

test("evaluateRules: a hard gate whose false_result is WATCH never contributes to failedGates", () => {
  const { traces, failedGates } = evaluateRules([smmTwr001], { tide_macd_slope: "falling" }, {});
  assert.equal(traces[0].result, "WATCH");
  assert.deepEqual(failedGates, []);
});

test("evaluateRules: a hard gate with an unresolvable expression (MANUAL_REVIEW) never contributes to failedGates", () => {
  const gueImpulse001 = {
    rule_id: "GUE-IMPULSE-001",
    name: "Wave 2 retracement limit",
    expression: "wave_2_retracement_fraction < 1.0",
    inputs: ["wave_2_retracement_fraction"],
    parameters: [],
    true_result: "PASS",
    false_result: "FAIL",
    missing_result: "MANUAL_REVIEW",
    hard_gate: true,
    source_status: "DOCUMENTED",
  };
  const { traces, failedGates } = evaluateRules([gueImpulse001], {}, {});
  assert.equal(traces[0].result, "MANUAL_REVIEW");
  assert.deepEqual(failedGates, []);
});

test("evaluateRules: mutually exclusive bullish/bearish hard gates never both block the same instrument via non-FAIL results", () => {
  const smmTwr002 = { ...smmTwr001, rule_id: "SMM-TWR-002", expression: "tide_macd_slope == 'falling'" };
  // A genuinely bullish instrument: TWR-001 passes, TWR-002 (the mutually
  // exclusive bearish counterpart) legitimately reads WATCH, not FAIL.
  const { failedGates } = evaluateRules([smmTwr001, smmTwr002], { tide_macd_slope: "rising" }, {});
  assert.deepEqual(failedGates, []);
});

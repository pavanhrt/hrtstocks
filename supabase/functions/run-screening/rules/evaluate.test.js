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

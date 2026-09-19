import { test } from "node:test";
import assert from "node:assert/strict";
import { filterScreeningRules } from "./screening-rules.js";

const SCREENING_RULE = { rule_id: "SMM-TWR-001", timeframe: "tide,wave" };
const DECISION_RULE = { rule_id: "SMM-RISK-001", timeframe: "decision" };
const PORTFOLIO_RULE = { rule_id: "SMM-SIZE-001", timeframe: "portfolio" };
const PORTFOLIO_MONTH_RULE = { rule_id: "SMM-MONTHLY-001", timeframe: "portfolio_month" };
const BSA_DAILY_RULE = { rule_id: "BSA-D1", timeframe: "daily", framework: "BSA" };
const BSA_GATE_RULE = { rule_id: "BSA-G1", timeframe: "combined", framework: "BSA" };

test("filterScreeningRules: keeps screening-stage rules", () => {
  const result = filterScreeningRules([SCREENING_RULE]);
  assert.deepEqual(result, [SCREENING_RULE]);
});

test("filterScreeningRules: excludes decision/portfolio/portfolio_month-timeframe rules", () => {
  const result = filterScreeningRules([SCREENING_RULE, DECISION_RULE, PORTFOLIO_RULE, PORTFOLIO_MONTH_RULE]);
  assert.deepEqual(result, [SCREENING_RULE]);
});

test("filterScreeningRules: null/undefined input is an empty array, not a throw", () => {
  assert.deepEqual(filterScreeningRules(null), []);
  assert.deepEqual(filterScreeningRules(undefined), []);
});

test("filterScreeningRules: excludes BSA framework rules regardless of their own timeframe", () => {
  const result = filterScreeningRules([SCREENING_RULE, BSA_DAILY_RULE, BSA_GATE_RULE]);
  assert.deepEqual(result, [SCREENING_RULE]);
});

test("filterScreeningRules: BSA-G1's hard_gate:true can never reach ordinary screening's evaluateRules/classify at all", () => {
  // BSA-G1's own timeframe is "combined" -- not one of the excluded
  // decision/portfolio timeframes -- so only the framework exclusion stops
  // it. This is a regression guard for exactly the incident this filter
  // exists to prevent: a hard-gate rule from an unrelated framework silently
  // rejecting (or passing) every instrument in the whole screening universe.
  const result = filterScreeningRules([BSA_GATE_RULE]);
  assert.deepEqual(result, []);
});

import { test } from "node:test";
import assert from "node:assert/strict";
import { filterScreeningRules } from "./screening-rules.js";

const SCREENING_RULE = { rule_id: "SMM-TWR-001", timeframe: "tide,wave" };
const DECISION_RULE = { rule_id: "SMM-RISK-001", timeframe: "decision" };
const PORTFOLIO_RULE = { rule_id: "SMM-SIZE-001", timeframe: "portfolio" };
const PORTFOLIO_MONTH_RULE = { rule_id: "SMM-MONTHLY-001", timeframe: "portfolio_month" };

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

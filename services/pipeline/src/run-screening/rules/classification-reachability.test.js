// Regression/invariant coverage for the classification-architecture fix
// (P0-1 of the 2026-09-11 correction cycle): before this fix, every
// instrument in the universe was rejected because evaluateRules() treated
// any non-PASS hard-gate result -- including WATCH (SMM-TWR-001/002's
// false_result) and MANUAL_REVIEW (GUE-IMPULSE-001/002/003's missing_result,
// since their wave-arithmetic inputs aren't computed at screening stage) --
// as a rejection, and decision/portfolio-stage SMM gates (whose
// entry/stop/target/capital inputs don't exist at screening time) were
// evaluated anyway and always resolved to a missing_result that got treated
// the same way. Live production data confirmed 0 PASS / 0 WATCH /
// 0 MANUAL_REVIEW across all 502 instruments in the last run before this fix.
//
// These tests build a screening-stage rule set shaped like the real
// smm.yaml/gue.yaml/papa.yaml hard gates (not the actual YAML files, to keep
// this suite decoupled from strategy-content edits) and prove the pipeline
// can reach a non-rejected terminal state end-to-end (filterScreeningRules
// -> evaluateRules -> classify), for both directions.

import { test } from "node:test";
import assert from "node:assert/strict";
import { evaluateRules } from "./evaluate.js";
import { classify } from "../rank.js";
import { filterScreeningRules } from "../pipeline/screening-rules.js";

const SMM_TWR_001 = {
  rule_id: "SMM-TWR-001",
  timeframe: "tide,wave",
  direction: "bullish",
  inputs: ["tide_macd_slope", "tide_macd_transition", "wave_bullish_oscillator_signal"],
  expression: "(tide_macd_slope == 'rising' or tide_macd_transition == 'flat_after_falling') and wave_bullish_oscillator_signal",
  true_result: "PASS",
  false_result: "WATCH",
  missing_result: "NO_DATA",
  hard_gate: true,
};

const SMM_TWR_002 = {
  rule_id: "SMM-TWR-002",
  timeframe: "tide,wave",
  direction: "bearish",
  inputs: ["tide_macd_slope", "tide_macd_transition", "wave_bearish_oscillator_signal"],
  expression: "(tide_macd_slope == 'falling' or tide_macd_transition == 'flat_after_rising') and wave_bearish_oscillator_signal",
  true_result: "PASS",
  false_result: "WATCH",
  missing_result: "NO_DATA",
  hard_gate: true,
};

// Decision/portfolio-stage: excluded from screening by filterScreeningRules,
// so their inputs are deliberately never supplied in any fixture context
// below -- if the filter regresses, these would throw/NO_DATA and the
// pre-fix "any non-PASS blocks" behavior would reject every fixture.
const SMM_RISK_001 = { rule_id: "SMM-RISK-001", timeframe: "decision", direction: "bullish", inputs: ["entry", "stop", "target"], expression: "target > entry and entry > stop", true_result: "PASS", false_result: "FAIL", missing_result: "NO_DATA", hard_gate: true };
const SMM_RISK_002 = { rule_id: "SMM-RISK-002", timeframe: "decision", direction: "bearish", inputs: ["entry", "stop", "target"], expression: "stop > entry and entry > target", true_result: "PASS", false_result: "FAIL", missing_result: "NO_DATA", hard_gate: true };
const SMM_SIZE_001 = { rule_id: "SMM-SIZE-001", timeframe: "portfolio", direction: "both", inputs: ["capital", "entry", "stop"], expression: "planned_loss <= capital * max_position_risk_fraction", true_result: "PASS", false_result: "FAIL", missing_result: "NO_DATA", hard_gate: true };
const SMM_MONTHLY_001 = { rule_id: "SMM-MONTHLY-001", timeframe: "portfolio_month", direction: "both", inputs: ["monthly_loss_fraction"], expression: "monthly_loss_fraction < monthly_loss_stop_fraction", true_result: "PASS", false_result: "FAIL", missing_result: "NO_DATA", hard_gate: true };

const GUE_IMPULSE_001 = { rule_id: "GUE-IMPULSE-001", timeframe: null, direction: null, inputs: ["wave_2_retracement_fraction"], expression: "wave_2_retracement_fraction < 1.0", true_result: "PASS", false_result: "FAIL", missing_result: "MANUAL_REVIEW", hard_gate: true };
const GUE_IMPULSE_002 = { rule_id: "GUE-IMPULSE-002", timeframe: null, direction: null, inputs: ["wave_4_enters_wave_1_territory"], expression: "not wave_4_enters_wave_1_territory", true_result: "PASS", false_result: "FAIL", missing_result: "MANUAL_REVIEW", hard_gate: true };
const GUE_IMPULSE_003 = { rule_id: "GUE-IMPULSE-003", timeframe: null, direction: null, inputs: ["wave_3_length", "wave_1_length", "wave_5_length"], expression: "wave_3_length >= wave_1_length or wave_3_length >= wave_5_length", true_result: "PASS", false_result: "FAIL", missing_result: "MANUAL_REVIEW", hard_gate: true };

const PAPA_CONTEXT_001 = { rule_id: "PAPA-CONTEXT-001", timeframe: "wave", direction: "both", inputs: ["at_trend_extreme", "at_major_support", "at_major_resistance", "at_exhaustion_area"], expression: "at_trend_extreme or at_major_support or at_major_resistance or at_exhaustion_area", true_result: "PASS", false_result: "FAIL", missing_result: "MANUAL_REVIEW", hard_gate: true };

const ALL_RULES = [SMM_TWR_001, SMM_TWR_002, SMM_RISK_001, SMM_RISK_002, SMM_SIZE_001, SMM_MONTHLY_001, GUE_IMPULSE_001, GUE_IMPULSE_002, GUE_IMPULSE_003, PAPA_CONTEXT_001];

function runScreening(context) {
  const screeningRules = filterScreeningRules(ALL_RULES);
  const { traces, failedGates } = evaluateRules(screeningRules, context, {});
  const { terminalState, tier } = classify(traces, failedGates, "PASS");
  return { traces, failedGates, terminalState, tier };
}

test("a fully-resolved bullish fixture reaches a non-rejected terminal state (Tier A/B or Watch)", () => {
  const { terminalState, tier, failedGates } = runScreening({
    tide_macd_slope: "rising",
    tide_macd_transition: null,
    wave_bullish_oscillator_signal: true,
    wave_bearish_oscillator_signal: false,
    wave_2_retracement_fraction: 0.5,
    wave_4_enters_wave_1_territory: false,
    wave_3_length: 10,
    wave_1_length: 5,
    wave_5_length: 6,
    at_trend_extreme: true,
    at_major_support: false,
    at_major_resistance: false,
    at_exhaustion_area: false,
  });
  assert.deepEqual(failedGates, []);
  assert.notEqual(terminalState, "FAIL");
  assert.ok(["tier_a", "tier_b", "watch"].includes(tier), `expected tier_a/tier_b/watch, got ${tier}`);
});

test("a fully-resolved bearish fixture reaches a non-rejected terminal state (Tier A/B or Watch)", () => {
  const { terminalState, tier, failedGates } = runScreening({
    tide_macd_slope: "falling",
    tide_macd_transition: null,
    wave_bullish_oscillator_signal: false,
    wave_bearish_oscillator_signal: true,
    wave_2_retracement_fraction: 0.5,
    wave_4_enters_wave_1_territory: false,
    wave_3_length: 10,
    wave_1_length: 5,
    wave_5_length: 6,
    at_trend_extreme: true,
    at_major_support: false,
    at_major_resistance: false,
    at_exhaustion_area: false,
  });
  assert.deepEqual(failedGates, []);
  assert.notEqual(terminalState, "FAIL");
  assert.ok(["tier_a", "tier_b", "watch"].includes(tier), `expected tier_a/tier_b/watch, got ${tier}`);
});

test("mutually exclusive bullish/bearish hard gates (SMM-TWR-001 vs 002) cannot reject a genuinely bullish instrument", () => {
  const { failedGates, terminalState } = runScreening({
    tide_macd_slope: "rising",
    tide_macd_transition: null,
    wave_bullish_oscillator_signal: true,
    wave_bearish_oscillator_signal: false,
  });
  // TWR-002 (bearish) legitimately reads WATCH for a bullish instrument --
  // it must never contribute a FAIL just because the opposite direction's
  // condition wasn't met.
  assert.ok(!failedGates.includes("SMM-TWR-002"));
  assert.notEqual(terminalState, "FAIL");
});

test("an instrument with no directional data at all is MANUAL_REVIEW, never a silent hard FAIL", () => {
  const { terminalState, tier, failedGates } = runScreening({});
  assert.deepEqual(failedGates, []);
  assert.equal(terminalState, "MANUAL_REVIEW");
  assert.equal(tier, "manual_review");
});

test("decision/portfolio-stage gates never appear in a screening run's traces at all", () => {
  const { traces } = runScreening({});
  const ids = traces.map((t) => t.rule_id);
  assert.ok(!ids.includes("SMM-RISK-001"));
  assert.ok(!ids.includes("SMM-RISK-002"));
  assert.ok(!ids.includes("SMM-SIZE-001"));
  assert.ok(!ids.includes("SMM-MONTHLY-001"));
});

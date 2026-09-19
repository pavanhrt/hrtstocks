import { test } from "node:test";
import assert from "node:assert/strict";
import { evaluateExpression, ExpressionError } from "./engine.js";

test("boolean and/or/not", () => {
  assert.equal(evaluateExpression("true and false", {}), false);
  assert.equal(evaluateExpression("true or false", {}), true);
  assert.equal(evaluateExpression("not false", {}), true);
  assert.equal(evaluateExpression("not (true and false)", {}), true);
});

test("comparisons distinguish > from >=", () => {
  assert.equal(evaluateExpression("a > b", { a: 5, b: 5 }), false);
  assert.equal(evaluateExpression("a >= b", { a: 5, b: 5 }), true);
});

test("missing input propagates as null, not a pass", () => {
  assert.equal(evaluateExpression("a > b", { a: 5, b: null }), null);
  assert.equal(evaluateExpression("a and b", { a: true, b: null }), null);
});

test("division by zero yields null rather than throwing", () => {
  assert.equal(evaluateExpression("reward / risk >= 3", { reward: 10, risk: 0 }), null);
});

test("string equality", () => {
  assert.equal(
    evaluateExpression("tide_macd_slope == 'rising'", { tide_macd_slope: "rising" }),
    true
  );
  assert.equal(
    evaluateExpression("tide_macd_slope == 'rising'", { tide_macd_slope: "falling" }),
    false
  );
});

test("in operator against a list literal", () => {
  assert.equal(evaluateExpression("state in ['flat', 'falling']", { state: "flat" }), true);
  assert.equal(evaluateExpression("state in ['flat', 'falling']", { state: "rising" }), false);
  assert.equal(evaluateExpression("state in ['flat', 'falling']", { state: null }), null);
});

test("FOME-RANGE-001 combines in-lists with comparisons", () => {
  const expr =
    "tide_macd_state == 'flat' and wave_adx_slope in ['flat', 'falling'] and wave_adx < 12 and bollinger_state in ['flat', 'BKT', 'BKP']";
  assert.equal(
    evaluateExpression(expr, {
      tide_macd_state: "flat",
      wave_adx_slope: "falling",
      wave_adx: 9,
      bollinger_state: "BKT",
    }),
    true
  );
  assert.equal(
    evaluateExpression(expr, {
      tide_macd_state: "flat",
      wave_adx_slope: "rising",
      wave_adx: 9,
      bollinger_state: "BKT",
    }),
    false
  );
});

test("unknown identifier is a hard error, not a silent null", () => {
  assert.throws(() => evaluateExpression("typo_field > 1", {}), ExpressionError);
});

// --- Golden cases lifted directly from strategies/smm.yaml -----------------

test("SMM-TREND-001 bullish trend structure", () => {
  const expr = "confirmed_higher_high and confirmed_higher_low";
  assert.equal(
    evaluateExpression(expr, { confirmed_higher_high: true, confirmed_higher_low: true }),
    true
  );
  assert.equal(
    evaluateExpression(expr, { confirmed_higher_high: true, confirmed_higher_low: false }),
    false
  );
});

test("SMM-EMA-001 bullish EMA alignment", () => {
  const expr = "ema_5 > ema_13 and ema_13 > ema_26 and ema_26 > ema_50";
  assert.equal(
    evaluateExpression(expr, { ema_5: 105, ema_13: 102, ema_26: 100, ema_50: 98 }),
    true
  );
  assert.equal(
    evaluateExpression(expr, { ema_5: 100, ema_13: 102, ema_26: 100, ema_50: 98 }),
    false
  );
});

test("SMM-TWR-001 bullish tide-wave alignment", () => {
  const expr =
    "(tide_macd_slope == 'rising' or tide_macd_transition == 'flat_after_falling') and wave_bullish_oscillator_signal";
  assert.equal(
    evaluateExpression(expr, {
      tide_macd_slope: "rising",
      tide_macd_transition: "none",
      wave_bullish_oscillator_signal: true,
    }),
    true
  );
  assert.equal(
    evaluateExpression(expr, {
      tide_macd_slope: "falling",
      tide_macd_transition: "none",
      wave_bullish_oscillator_signal: true,
    }),
    false
  );
});

test("SMM-VOL-001 breakout volume confirmation", () => {
  const expr = "trigger_volume >= average_volume * volume_multiplier";
  assert.equal(
    evaluateExpression(expr, { trigger_volume: 200, average_volume: 100, volume_multiplier: 1.5 }),
    true
  );
  assert.equal(evaluateExpression(expr, { trigger_volume: null, average_volume: 100, volume_multiplier: 1.5 }), null);
});

test("SMM-RISK-001 positive bullish reward and risk", () => {
  const expr = "target > entry and entry > stop";
  assert.equal(evaluateExpression(expr, { target: 120, entry: 110, stop: 100 }), true);
  assert.equal(evaluateExpression(expr, { target: 105, entry: 110, stop: 100 }), false);
});

test("SMM-RR-001 minimum reward-risk hard gate", () => {
  const expr = "risk > 0 and reward / risk >= minimum_reward_risk";
  assert.equal(evaluateExpression(expr, { risk: 10, reward: 35, minimum_reward_risk: 3.0 }), true);
  assert.equal(evaluateExpression(expr, { risk: 10, reward: 20, minimum_reward_risk: 3.0 }), false);
  assert.equal(evaluateExpression(expr, { risk: 0, reward: 20, minimum_reward_risk: 3.0 }), false);
});

test("SMM-SIZE-001 position risk ceiling", () => {
  const expr = "planned_loss <= capital * max_position_risk_fraction";
  assert.equal(
    evaluateExpression(expr, { planned_loss: 1800, capital: 100000, max_position_risk_fraction: 0.02 }),
    true
  );
  assert.equal(
    evaluateExpression(expr, { planned_loss: 2200, capital: 100000, max_position_risk_fraction: 0.02 }),
    false
  );
});

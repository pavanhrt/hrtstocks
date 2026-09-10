import { test } from "node:test";
import assert from "node:assert/strict";
import { evaluateExpression } from "./engine.js";

// Golden cases lifted directly from strategies/buy-swing.yaml / sell-swing.yaml
// (WBP-M1..M4 / WSP-S1..S4 -- the only gates with a real expression; M5..M8/
// S5..S8 are `manual_review` sentinels, nothing to evaluate).

test("WBP-M1 weekly Dow direction: passes on an intact uptrend or a confirmed bullish reversal, fails otherwise", () => {
  const expr = "weekly_dow_state == 'uptrend_intact' or weekly_dow_state == 'confirmed_reversal_bullish'";
  assert.equal(evaluateExpression(expr, { weekly_dow_state: "uptrend_intact" }), true);
  assert.equal(evaluateExpression(expr, { weekly_dow_state: "confirmed_reversal_bullish" }), true);
  assert.equal(evaluateExpression(expr, { weekly_dow_state: "downtrend_intact" }), false);
  assert.equal(evaluateExpression(expr, { weekly_dow_state: "sideways" }), false);
});

test("WBP-M2 weekly Elliott position: passes inside a bullish motive wave 1/3/5, or a completed bearish (correction) zigzag", () => {
  const expr =
    "(weekly_elliott_structure_type == 'impulse' and weekly_elliott_direction == 'bullish' and weekly_elliott_current_wave in ['1', '3', '5']) or (weekly_elliott_structure_type == 'zigzag' and weekly_elliott_direction == 'bearish' and weekly_elliott_wave_state == 'completed')";
  assert.equal(
    evaluateExpression(expr, { weekly_elliott_structure_type: "impulse", weekly_elliott_direction: "bullish", weekly_elliott_current_wave: "3", weekly_elliott_wave_state: "forming" }),
    true
  );
  assert.equal(
    evaluateExpression(expr, { weekly_elliott_structure_type: "zigzag", weekly_elliott_direction: "bearish", weekly_elliott_current_wave: "C", weekly_elliott_wave_state: "completed" }),
    true
  );
  // wave 2/4 forming (a correction inside the impulse, not itself 1/3/5) does not pass
  assert.equal(
    evaluateExpression(expr, { weekly_elliott_structure_type: "impulse", weekly_elliott_direction: "bullish", weekly_elliott_current_wave: "4", weekly_elliott_wave_state: "forming" }),
    false
  );
  // a bearish impulse (falling motive) does not pass the bullish gate
  assert.equal(
    evaluateExpression(expr, { weekly_elliott_structure_type: "impulse", weekly_elliott_direction: "bearish", weekly_elliott_current_wave: "3", weekly_elliott_wave_state: "forming" }),
    false
  );
  // a zigzag that hasn't completed (still forming B or C) does not pass -- correction isn't over yet
  assert.equal(
    evaluateExpression(expr, { weekly_elliott_structure_type: "zigzag", weekly_elliott_direction: "bearish", weekly_elliott_current_wave: "C", weekly_elliott_wave_state: "forming" }),
    false
  );
});

test("WBP-M3 daily Dow direction: requires an intact/reversed uptrend AND no live triggered bearish daily pattern", () => {
  const expr = "(daily_dow_state == 'uptrend_intact' or daily_dow_state == 'confirmed_reversal_bullish') and daily_no_live_triggered_bearish_pattern";
  assert.equal(evaluateExpression(expr, { daily_dow_state: "uptrend_intact", daily_no_live_triggered_bearish_pattern: true }), true);
  // a triggered bearish pattern vetoes an otherwise-intact uptrend
  assert.equal(evaluateExpression(expr, { daily_dow_state: "uptrend_intact", daily_no_live_triggered_bearish_pattern: false }), false);
  assert.equal(evaluateExpression(expr, { daily_dow_state: "downtrend_intact", daily_no_live_triggered_bearish_pattern: true }), false);
});

test("WBP-M4 daily wave + Tide: requires a bullish motive wave 1/3/5 AND MACD uptick or flat-after-down", () => {
  const expr =
    "(daily_elliott_structure_type == 'impulse' and daily_elliott_direction == 'bullish' and daily_elliott_current_wave in ['1', '3', '5']) and (daily_macd_histogram_change == 'uptick' or (daily_macd_histogram_change == 'flat' and daily_macd_histogram_prior_phase == 'down'))";
  const wave3 = { daily_elliott_structure_type: "impulse", daily_elliott_direction: "bullish", daily_elliott_current_wave: "3" };
  assert.equal(evaluateExpression(expr, { ...wave3, daily_macd_histogram_change: "uptick", daily_macd_histogram_prior_phase: "up" }), true);
  assert.equal(evaluateExpression(expr, { ...wave3, daily_macd_histogram_change: "flat", daily_macd_histogram_prior_phase: "down" }), true);
  // flat after an UP phase (not down) does not satisfy the tie-break
  assert.equal(evaluateExpression(expr, { ...wave3, daily_macd_histogram_change: "flat", daily_macd_histogram_prior_phase: "up" }), false);
  assert.equal(evaluateExpression(expr, { ...wave3, daily_macd_histogram_change: "downtick", daily_macd_histogram_prior_phase: "up" }), false);
});

test("WSP-S1 weekly Dow direction: passes on an intact downtrend or a confirmed bearish reversal", () => {
  const expr = "weekly_dow_state == 'downtrend_intact' or weekly_dow_state == 'confirmed_reversal_bearish'";
  assert.equal(evaluateExpression(expr, { weekly_dow_state: "downtrend_intact" }), true);
  assert.equal(evaluateExpression(expr, { weekly_dow_state: "confirmed_reversal_bearish" }), true);
  assert.equal(evaluateExpression(expr, { weekly_dow_state: "uptrend_intact" }), false);
});

test("WSP-S2 weekly Elliott position: passes inside a falling motive, a completed 5-up, or a completed bullish zigzag", () => {
  const expr =
    "(weekly_elliott_structure_type == 'impulse' and weekly_elliott_direction == 'bearish' and weekly_elliott_current_wave in ['1', '3', '5']) or (weekly_elliott_structure_type == 'impulse' and weekly_elliott_direction == 'bullish' and weekly_elliott_current_wave == '5' and weekly_elliott_wave_state == 'completed') or (weekly_elliott_structure_type == 'zigzag' and weekly_elliott_direction == 'bullish' and weekly_elliott_wave_state == 'completed')";
  assert.equal(
    evaluateExpression(expr, { weekly_elliott_structure_type: "impulse", weekly_elliott_direction: "bearish", weekly_elliott_current_wave: "3", weekly_elliott_wave_state: "forming" }),
    true
  );
  // a completed bullish wave 5 (exhaustion) sets up the reversal
  assert.equal(
    evaluateExpression(expr, { weekly_elliott_structure_type: "impulse", weekly_elliott_direction: "bullish", weekly_elliott_current_wave: "5", weekly_elliott_wave_state: "completed" }),
    true
  );
  // a bullish wave 5 that is still forming (not yet exhausted) does not pass
  assert.equal(
    evaluateExpression(expr, { weekly_elliott_structure_type: "impulse", weekly_elliott_direction: "bullish", weekly_elliott_current_wave: "5", weekly_elliott_wave_state: "forming" }),
    false
  );
  assert.equal(
    evaluateExpression(expr, { weekly_elliott_structure_type: "zigzag", weekly_elliott_direction: "bullish", weekly_elliott_current_wave: "C", weekly_elliott_wave_state: "completed" }),
    true
  );
});

test("WSP-S3 daily Dow direction: requires an intact/reversed downtrend AND no live triggered bullish daily pattern", () => {
  const expr = "(daily_dow_state == 'downtrend_intact' or daily_dow_state == 'confirmed_reversal_bearish') and daily_no_live_triggered_bullish_pattern";
  assert.equal(evaluateExpression(expr, { daily_dow_state: "downtrend_intact", daily_no_live_triggered_bullish_pattern: true }), true);
  assert.equal(evaluateExpression(expr, { daily_dow_state: "downtrend_intact", daily_no_live_triggered_bullish_pattern: false }), false);
});

test("WSP-S4 daily wave + Tide: requires a bearish motive wave 1/3/5 AND MACD downtick or flat-after-up", () => {
  const expr =
    "(daily_elliott_structure_type == 'impulse' and daily_elliott_direction == 'bearish' and daily_elliott_current_wave in ['1', '3', '5']) and (daily_macd_histogram_change == 'downtick' or (daily_macd_histogram_change == 'flat' and daily_macd_histogram_prior_phase == 'up'))";
  const wave3 = { daily_elliott_structure_type: "impulse", daily_elliott_direction: "bearish", daily_elliott_current_wave: "3" };
  assert.equal(evaluateExpression(expr, { ...wave3, daily_macd_histogram_change: "downtick", daily_macd_histogram_prior_phase: "down" }), true);
  assert.equal(evaluateExpression(expr, { ...wave3, daily_macd_histogram_change: "flat", daily_macd_histogram_prior_phase: "up" }), true);
  assert.equal(evaluateExpression(expr, { ...wave3, daily_macd_histogram_change: "flat", daily_macd_histogram_prior_phase: "down" }), false);
});

test("WBP-M2/WSP-S2 resolve to null (NO_DATA upstream) when an input is missing, never a guessed pass", () => {
  const expr =
    "(weekly_elliott_structure_type == 'impulse' and weekly_elliott_direction == 'bullish' and weekly_elliott_current_wave in ['1', '3', '5']) or (weekly_elliott_structure_type == 'zigzag' and weekly_elliott_direction == 'bearish' and weekly_elliott_wave_state == 'completed')";
  assert.equal(
    evaluateExpression(expr, { weekly_elliott_structure_type: null, weekly_elliott_direction: null, weekly_elliott_current_wave: null, weekly_elliott_wave_state: null }),
    null
  );
});

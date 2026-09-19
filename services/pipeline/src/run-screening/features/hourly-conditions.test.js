import { test } from "node:test";
import assert from "node:assert/strict";
import { evaluateHourlyAdxCondition } from "./hourly-conditions.js";

const WAIT_BELOW = 14;
const FLAT_CEILING = 25;

function trendingBars(count, drift, startPrice = 100) {
  const highs = [];
  const lows = [];
  const closes = [];
  let price = startPrice;
  for (let i = 0; i < count; i++) {
    price += drift;
    highs.push(price + 1);
    lows.push(price - 1);
    closes.push(price);
  }
  return { highs, lows, closes };
}

function choppyBars(count, startPrice = 100) {
  const highs = [];
  const lows = [];
  const closes = [];
  for (let i = 0; i < count; i++) {
    const price = startPrice + (i % 2 === 0 ? 1 : -1);
    highs.push(price + 0.5);
    lows.push(price - 0.5);
    closes.push(price);
  }
  return { highs, lows, closes };
}

test("evaluateHourlyAdxCondition returns null (never a guess) before ADX has enough hourly bars", () => {
  const { highs, lows, closes } = trendingBars(10, 1);
  assert.equal(
    evaluateHourlyAdxCondition({ highs, lows, closes, period: 14, waitBelowThreshold: WAIT_BELOW, flatCeiling: FLAT_CEILING }),
    null
  );
});

test("evaluateHourlyAdxCondition waits when ADX sits below the swing-specific 14 threshold (choppy, directionless hourly chart)", () => {
  const { highs, lows, closes } = choppyBars(60);
  const result = evaluateHourlyAdxCondition({ highs, lows, closes, period: 14, waitBelowThreshold: WAIT_BELOW, flatCeiling: FLAT_CEILING });
  assert.ok(result.adx < WAIT_BELOW, `expected ADX below ${WAIT_BELOW}, got ${result.adx}`);
  assert.equal(result.wait, true);
  assert.match(result.reason, /< 14/);
});

test("evaluateHourlyAdxCondition does not wait on a strong, clearly-trending hourly chart", () => {
  const { highs, lows, closes } = trendingBars(60, 2);
  const result = evaluateHourlyAdxCondition({ highs, lows, closes, period: 14, waitBelowThreshold: WAIT_BELOW, flatCeiling: FLAT_CEILING });
  assert.ok(result.adx >= WAIT_BELOW, `expected ADX at/above ${WAIT_BELOW}, got ${result.adx}`);
  assert.equal(result.wait, false);
  assert.equal(result.reason, null);
});

test("evaluateHourlyAdxCondition surfaces the raw +DI/-DI/ADX/slope evidence regardless of the wait verdict", () => {
  const { highs, lows, closes } = trendingBars(60, 2);
  const result = evaluateHourlyAdxCondition({ highs, lows, closes, period: 14, waitBelowThreshold: WAIT_BELOW, flatCeiling: FLAT_CEILING });
  assert.ok(result.plusDI > result.minusDI);
  assert.ok(["rising", "falling", "flat"].includes(result.slope));
});

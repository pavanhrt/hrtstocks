import { test } from "node:test";
import assert from "node:assert/strict";
import { buildFeatureContext } from "./context.js";

const DOCUMENTED = {
  ema_periods: [5, 13, 26, 50],
  macd_fast: 12,
  macd_slow: 26,
  macd_signal: 9,
  papa_extreme_bollinger_deviation: 3.0,
  rsi_period: 14,
  stochastic_lookback: 14,
  stochastic_smoothing: 3,
  bollinger_lookback: 20,
  standard_bollinger_deviation: 2.0,
  volume_lookback: 20,
  volume_multiplier: 1.0,
  zigzag_weekly_pct: 0.05,
  zigzag_monthly_pct: 0.05,
};

function makeDailyBars(count, startDate = "2024-01-01") {
  const start = new Date(startDate + "T00:00:00Z");
  const bars = [];
  let price = 100;
  for (let i = 0; i < count; i++) {
    const date = new Date(start);
    date.setUTCDate(date.getUTCDate() + i);
    price += Math.sin(i / 7) * 2 + 0.1;
    bars.push({
      date: date.toISOString().slice(0, 10),
      open: price - 0.5,
      high: price + 1,
      low: price - 1,
      close: price,
      volume: 100000 + (i % 5) * 1000,
    });
  }
  return bars;
}

test("buildFeatureContext still computes documented EMA periods and close (backward compatible)", () => {
  const bars = makeDailyBars(60);
  const context = buildFeatureContext(bars, DOCUMENTED);
  assert.ok(typeof context.ema_5 === "number");
  assert.equal(context.close, bars.at(-1).close);
});

test("buildFeatureContext computes daily rsi/stochastic once 365 days of bars are available", () => {
  const bars = makeDailyBars(365);
  const context = buildFeatureContext(bars, DOCUMENTED);
  assert.ok(typeof context.daily_rsi === "number");
  assert.ok(typeof context.daily_stochastic_k === "number");
  assert.ok(typeof context.average_volume === "number");
  assert.ok(typeof context.bollinger_upper_3sd === "number");
});

test("buildFeatureContext computes a weekly and monthly dow_state from 365 days of daily bars", () => {
  const bars = makeDailyBars(365);
  const context = buildFeatureContext(bars, DOCUMENTED);
  assert.ok(["uptrend_intact", "downtrend_intact", "confirmed_reversal_bullish", "confirmed_reversal_bearish", "sideways", "ambiguous"].includes(context.weekly_dow_state));
  assert.ok(["uptrend_intact", "downtrend_intact", "confirmed_reversal_bullish", "confirmed_reversal_bearish", "sideways", "ambiguous"].includes(context.monthly_dow_state));
});

test("buildFeatureContext omits weekly/monthly keys entirely when their zigzag parameter is unresolved", () => {
  const bars = makeDailyBars(365);
  const { zigzag_weekly_pct, zigzag_monthly_pct, ...withoutZigzag } = DOCUMENTED;
  const context = buildFeatureContext(bars, withoutZigzag);
  assert.equal("weekly_dow_state" in context, false);
  assert.equal("monthly_dow_state" in context, false);
});

test("buildFeatureContext handles too few bars for weekly/monthly aggregation without throwing", () => {
  const bars = makeDailyBars(3);
  const context = buildFeatureContext(bars, DOCUMENTED);
  assert.equal("weekly_dow_state" in context, false);
});

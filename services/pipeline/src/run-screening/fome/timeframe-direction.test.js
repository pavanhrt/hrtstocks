import { test } from "node:test";
import assert from "node:assert/strict";
import { buildFomeTimeframeRow, computeFomeAlignment, computeFomeTimeframeInputHash } from "./timeframe-direction.js";

const documentedParams = {
  macd_fast: 12,
  macd_slow: 26,
  macd_signal: 9,
  rsi_period: 14,
  adx_dmi_period: 14,
  bollinger_lookback: 20,
  standard_bollinger_deviation: 2.0,
  volume_lookback: 20,
  volume_multiplier: 1.0,
  zigzag_monthly_pct: 0.05,
  zigzag_weekly_pct: 0.05,
  zigzag_daily_pct: 0.025,
  zigzag_fifteen_minute_pct: 0.01,
};

function makeUptrendBars(n, startPrice = 100) {
  const bars = [];
  for (let i = 0; i < n; i++) {
    const wave = Math.sin(i / 3) * 3;
    const price = startPrice + i * 1.5 + wave;
    bars.push({
      date: new Date(2020, 0, i + 1).toISOString().slice(0, 10),
      open: price - 1,
      high: price + 2,
      low: price - 2,
      close: price,
      volume: 100000 + (i % 5) * 1000,
    });
  }
  return bars;
}

function makeFlatBars(n, price = 200) {
  const bars = [];
  for (let i = 0; i < n; i++) {
    const wiggle = (i % 2 === 0 ? 1 : -1) * 0.5;
    bars.push({
      date: new Date(2020, 0, i + 1).toISOString().slice(0, 10),
      open: price,
      high: price + 1 + wiggle,
      low: price - 1 + wiggle,
      close: price + wiggle,
      volume: 50000,
    });
  }
  return bars;
}

test("buildFomeTimeframeRow: no bars is unavailable, not a guessed row", () => {
  const row = buildFomeTimeframeRow("daily", [], documentedParams);
  assert.equal(row.confidence, "unavailable");
  assert.equal(row.direction, null);
});

test("buildFomeTimeframeRow: monthly/weekly/daily use zigzag Dow classification", () => {
  const row = buildFomeTimeframeRow("daily", makeUptrendBars(120), documentedParams);
  assert.ok(row.dowState);
  assert.ok(row.rsi != null);
});

test("buildFomeTimeframeRow: 15m reuses this repo's own documented zigzag_fifteen_minute_pct (never invents a new threshold)", () => {
  const row = buildFomeTimeframeRow("15m", makeUptrendBars(120), documentedParams, { isProvisional: true });
  assert.ok(row.dowState); // this repo already resolved a 15m zigzag threshold for buy-setup's own wave module -- FOME reuses it
});

test("buildFomeTimeframeRow: an unresolved zigzag threshold for a timeframe falls back to momentum, never invents one", () => {
  const paramsWithoutFifteen = { ...documentedParams, zigzag_fifteen_minute_pct: null };
  const row = buildFomeTimeframeRow("15m", makeFlatBars(40), paramsWithoutFifteen, { isProvisional: true });
  assert.equal(row.dowState, null);
  assert.equal(row.confidence, "provisional");
});

test("computeFomeAlignment: Monthly+Weekly bullish agreement with Daily agreeing -> ALIGNED_BULLISH", () => {
  const bullish = { direction: "bullish", confidence: "confirmed", bollingerState: "flat" };
  const result = computeFomeAlignment({ monthly: bullish, weekly: bullish, daily: bullish, fifteenMin: { direction: "bullish" } });
  assert.equal(result.finalAlignment, "ALIGNED_BULLISH");
});

test("computeFomeAlignment: Monthly+Weekly bearish agreement -> ALIGNED_BEARISH", () => {
  const bearish = { direction: "bearish", confidence: "confirmed", bollingerState: "flat" };
  const result = computeFomeAlignment({ monthly: bearish, weekly: bearish, daily: bearish, fifteenMin: null });
  assert.equal(result.finalAlignment, "ALIGNED_BEARISH");
});

test("computeFomeAlignment: Monthly/Weekly disagreement -> MIXED, never forced", () => {
  const bullish = { direction: "bullish", confidence: "confirmed" };
  const bearish = { direction: "bearish", confidence: "confirmed" };
  const result = computeFomeAlignment({ monthly: bullish, weekly: bearish, daily: null, fifteenMin: null });
  assert.equal(result.finalAlignment, "MIXED");
});

test("computeFomeAlignment: both sideways with flat Bollinger -> SIDEWAYS", () => {
  const sideways = { direction: "sideways", confidence: "confirmed", bollingerState: "flat" };
  const result = computeFomeAlignment({ monthly: sideways, weekly: sideways, daily: sideways, fifteenMin: null });
  assert.equal(result.finalAlignment, "SIDEWAYS");
});

test("computeFomeAlignment: both sideways with expanding Bollinger -> VOLATILITY_EXPANSION", () => {
  const sideways = { direction: "sideways", confidence: "confirmed", bollingerState: "expanding" };
  const result = computeFomeAlignment({ monthly: sideways, weekly: sideways, daily: null, fifteenMin: null });
  assert.equal(result.finalAlignment, "VOLATILITY_EXPANSION");
});

test("computeFomeAlignment: missing Monthly or Weekly -> UNAVAILABLE, never a guess", () => {
  const bullish = { direction: "bullish", confidence: "confirmed" };
  assert.equal(computeFomeAlignment({ monthly: null, weekly: bullish, daily: null, fifteenMin: null }).finalAlignment, "UNAVAILABLE");
  assert.equal(
    computeFomeAlignment({ monthly: { direction: null, confidence: "unavailable" }, weekly: bullish, daily: null, fifteenMin: null }).finalAlignment,
    "UNAVAILABLE"
  );
});

test("computeFomeAlignment: higher timeframes aligned but 15-minute opposed -> WAIT_FOR_ENTRY_CONFIRMATION, never reversed", () => {
  const bullish = { direction: "bullish", confidence: "confirmed", bollingerState: "flat" };
  const opposedFifteen = { direction: "bearish" };
  const result = computeFomeAlignment({ monthly: bullish, weekly: bullish, daily: bullish, fifteenMin: opposedFifteen });
  assert.equal(result.finalAlignment, "WAIT_FOR_ENTRY_CONFIRMATION");
  assert.equal(result.underlyingAlignment, "ALIGNED_BULLISH");
});

test("computeFomeAlignment: Daily opposing an agreeing Monthly+Weekly -> MIXED", () => {
  const bullish = { direction: "bullish", confidence: "confirmed" };
  const bearishDaily = { direction: "bearish" };
  const result = computeFomeAlignment({ monthly: bullish, weekly: bullish, daily: bearishDaily, fifteenMin: null });
  assert.equal(result.finalAlignment, "MIXED");
});

test("computeFomeAlignment: ambiguous Monthly/Weekly structure -> MANUAL_REVIEW", () => {
  const ambiguous = { direction: null, confidence: "manual_review" };
  const bullish = { direction: "bullish", confidence: "confirmed" };
  const result = computeFomeAlignment({ monthly: ambiguous, weekly: bullish, daily: null, fifteenMin: null });
  assert.equal(result.finalAlignment, "MANUAL_REVIEW");
});

test("computeFomeTimeframeInputHash: identical bars and versions hash identically (cache is reusable)", () => {
  const bars = makeUptrendBars(10);
  const a = computeFomeTimeframeInputHash({ timeframeBars: bars, algorithmVersion: "1.0.0", parameterVersion: "1.6.0", adjustmentVersion: "1.0.0" });
  const b = computeFomeTimeframeInputHash({ timeframeBars: bars, algorithmVersion: "1.0.0", parameterVersion: "1.6.0", adjustmentVersion: "1.0.0" });
  assert.equal(a, b);
});

test("computeFomeTimeframeInputHash: a newly-completed period (extra bar) changes the hash", () => {
  const bars = makeUptrendBars(10);
  const extended = makeUptrendBars(11);
  const a = computeFomeTimeframeInputHash({ timeframeBars: bars, algorithmVersion: "1.0.0", parameterVersion: "1.6.0", adjustmentVersion: "1.0.0" });
  const b = computeFomeTimeframeInputHash({ timeframeBars: extended, algorithmVersion: "1.0.0", parameterVersion: "1.6.0", adjustmentVersion: "1.0.0" });
  assert.notEqual(a, b);
});

test("computeFomeTimeframeInputHash: a parameter-version bump changes the hash even with identical bars", () => {
  const bars = makeUptrendBars(10);
  const a = computeFomeTimeframeInputHash({ timeframeBars: bars, algorithmVersion: "1.0.0", parameterVersion: "1.6.0", adjustmentVersion: "1.0.0" });
  const b = computeFomeTimeframeInputHash({ timeframeBars: bars, algorithmVersion: "1.0.0", parameterVersion: "1.7.0", adjustmentVersion: "1.0.0" });
  assert.notEqual(a, b);
});

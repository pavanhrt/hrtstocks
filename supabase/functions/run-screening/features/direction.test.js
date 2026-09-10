import { test } from "node:test";
import assert from "node:assert/strict";
import { buildDirectionAnalysis } from "./direction.js";

const DOCUMENTED = {
  zigzag_daily_pct: 0.025,
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
    price += Math.sin(i / 7) * 3 + 0.15;
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

test("buildDirectionAnalysis returns daily/weekly/monthly entries with a dow_state and stable pivot-based hash", async () => {
  const bars = makeDailyBars(400);
  const result = await buildDirectionAnalysis(bars, DOCUMENTED);
  for (const timeframe of ["daily", "weekly", "monthly"]) {
    assert.ok(result[timeframe], `${timeframe} should be populated`);
    assert.ok(
      ["uptrend_intact", "downtrend_intact", "confirmed_reversal_bullish", "confirmed_reversal_bearish", "sideways", "ambiguous"].includes(
        result[timeframe].dowState
      )
    );
    assert.equal(typeof result[timeframe].inputHash, "string");
    assert.equal(result[timeframe].inputHash.length, 64); // hex-encoded SHA-256
  }
});

test("buildDirectionAnalysis produces the same hash for the same inputs (idempotent -- 'no change, keep the image')", async () => {
  const bars = makeDailyBars(400);
  const first = await buildDirectionAnalysis(bars, DOCUMENTED);
  const second = await buildDirectionAnalysis(bars, DOCUMENTED);
  assert.equal(first.daily.inputHash, second.daily.inputHash);
  assert.equal(first.weekly.inputHash, second.weekly.inputHash);
});

test("buildDirectionAnalysis produces a different hash once a new bar shifts the pivot structure", async () => {
  const bars = makeDailyBars(400);
  const before = await buildDirectionAnalysis(bars, DOCUMENTED);
  const extended = [...bars, { date: "2099-01-01", open: 200, high: 260, low: 199, close: 250, volume: 500000 }];
  const after = await buildDirectionAnalysis(extended, DOCUMENTED);
  assert.notEqual(before.daily.inputHash, after.daily.inputHash);
});

test("buildDirectionAnalysis skips a timeframe whose zigzag parameter is unresolved (never guesses a threshold)", async () => {
  const bars = makeDailyBars(400);
  const { zigzag_daily_pct, ...withoutDaily } = DOCUMENTED;
  const result = await buildDirectionAnalysis(bars, withoutDaily);
  assert.equal(result.daily, null);
  assert.ok(result.weekly);
});

test("buildDirectionAnalysis skips timeframes without enough bars instead of throwing", async () => {
  const bars = makeDailyBars(3);
  const result = await buildDirectionAnalysis(bars, DOCUMENTED);
  assert.equal(result.weekly, null);
  assert.equal(result.monthly, null);
});

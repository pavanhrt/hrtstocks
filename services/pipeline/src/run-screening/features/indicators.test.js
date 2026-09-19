import { test } from "node:test";
import assert from "node:assert/strict";
import {
  sma,
  ema,
  emaSeries,
  macd,
  bollingerBands,
  retracementFraction,
  highestHigh,
  lowestLow,
  rsi,
  rsiWithPrevious,
  stochastic,
  macdHistogramPhase,
  hourSlotAverageVolume,
  adx,
  adxSlope,
} from "./indicators.js";

/** Synthetic OHLC series with a steady per-bar drift, for ADX/DMI fixtures. */
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

/** Synthetic OHLC series that oscillates with no net directional movement, for a low-ADX fixture. */
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

test("sma returns null with insufficient history", () => {
  assert.equal(sma([1, 2], 5), null);
});

test("sma matches hand-computed average", () => {
  assert.equal(sma([10, 20, 30], 3), 20);
});

test("ema returns null before the seed period completes", () => {
  assert.equal(ema([1, 2], 5), null);
});

test("ema converges toward a constant series' value", () => {
  const closes = new Array(50).fill(100);
  assert.equal(ema(closes, 13), 100);
});

test("ema reacts in the correct direction to a trend", () => {
  const rising = Array.from({ length: 30 }, (_, i) => 100 + i);
  const value = ema(rising, 13);
  // EMA of a rising series should sit below the latest close but above the SMA-13 seed value.
  assert.ok(value !== null && value < rising[rising.length - 1]);
  assert.ok(value > sma(rising.slice(0, 13), 13));
});

test("emaSeries seeds with SMA at index period-1 and leaves earlier entries null", () => {
  const closes = [1, 2, 3, 4, 5, 6, 7, 8];
  const series = emaSeries(closes, 4);
  assert.equal(series[0], null);
  assert.equal(series[1], null);
  assert.equal(series[2], null);
  assert.equal(series[3], sma([1, 2, 3, 4], 4));
});

test("macd returns nulls without enough history", () => {
  const result = macd([1, 2, 3], 12, 26, 9);
  assert.equal(result.macd, null);
  assert.equal(result.signal, null);
});

test("macd histogram is macd minus signal", () => {
  const closes = Array.from({ length: 60 }, (_, i) => 100 + Math.sin(i / 5) * 10);
  const result = macd(closes, 12, 26, 9);
  assert.ok(result.macd !== null && result.signal !== null);
  assert.ok(Math.abs(result.histogram - (result.macd - result.signal)) < 1e-9);
});

test("bollingerBands upper/lower straddle the middle band symmetrically", () => {
  const closes = [10, 12, 11, 13, 12, 14, 13, 15, 14, 16];
  const { middle, upper, lower } = bollingerBands(closes, 10, 2);
  assert.ok(upper > middle && lower < middle);
  assert.ok(Math.abs(upper - middle - (middle - lower)) < 1e-9);
});

test("bollingerBands with zero closes still returns a defined middle", () => {
  const { middle, upper, lower } = bollingerBands([5, 5, 5, 5, 5], 5, 3);
  assert.equal(middle, 5);
  assert.equal(upper, 5);
  assert.equal(lower, 5);
});

test("retracementFraction: 0 at the high, 1 at the low", () => {
  assert.equal(retracementFraction(100, 50, 100), 0);
  assert.equal(retracementFraction(100, 50, 50), 1);
  assert.equal(retracementFraction(100, 50, 75), 0.5);
});

test("retracementFraction returns null for a degenerate (non-positive) range", () => {
  assert.equal(retracementFraction(50, 50, 50), null);
});

test("highestHigh / lowestLow over trailing window", () => {
  assert.equal(highestHigh([1, 5, 3, 9, 2], 3), 9);
  assert.equal(lowestLow([1, 5, 3, 9, 2], 3), 2);
  assert.equal(highestHigh([1, 2], 5), null);
});

test("rsi returns null without period + 1 bars of history", () => {
  assert.equal(rsi([1, 2, 3], 14), null);
});

test("rsi is 100 for a strictly rising series (no losses to average)", () => {
  const closes = Array.from({ length: 20 }, (_, i) => 100 + i);
  assert.equal(rsi(closes, 14), 100);
});

test("rsi sits below 50 for a strictly falling series", () => {
  const closes = Array.from({ length: 20 }, (_, i) => 200 - i);
  assert.ok(rsi(closes, 14) < 50);
});

test("rsiWithPrevious exposes the prior bar's value for crossover checks", () => {
  const closes = Array.from({ length: 20 }, (_, i) => 100 + i);
  const { value, previous } = rsiWithPrevious(closes, 14);
  assert.equal(value, 100);
  assert.ok(previous !== null);
});

test("stochastic returns nulls without enough bars for the lookback + smoothing window", () => {
  const { k, d } = stochastic([10, 11], [9, 10], [9.5, 10.5], 14, 3, 3);
  assert.equal(k, null);
  assert.equal(d, null);
});

test("stochastic %K sits near 100 when the close is at the top of its recent range", () => {
  const n = 25;
  const highs = Array.from({ length: n }, (_, i) => 10 + i * 0.5);
  const lows = Array.from({ length: n }, (_, i) => 9 + i * 0.5);
  const closes = Array.from({ length: n }, (_, i) => 10 + i * 0.5); // close = high each bar
  const { k } = stochastic(highs, lows, closes, 14, 3, 3);
  assert.ok(k > 90);
});

test("macdHistogramPhase returns nulls without enough history", () => {
  const { change, priorPhase } = macdHistogramPhase([1, 2, 3], 12, 26, 9);
  assert.equal(change, null);
  assert.equal(priorPhase, null);
});

test("macdHistogramPhase classifies a well-established trend's histogram as non-null", () => {
  const closes = Array.from({ length: 60 }, (_, i) => 100 + i * 1.5);
  const { change, priorPhase } = macdHistogramPhase(closes, 12, 26, 9, 4);
  assert.ok(["uptick", "downtick", "flat"].includes(change));
  assert.ok(["up", "down", "flat"].includes(priorPhase));
});

test("macdHistogramPhase on a flat (constant) series reports flat with no prior direction", () => {
  const closes = new Array(60).fill(100);
  const { change, priorPhase } = macdHistogramPhase(closes, 12, 26, 9, 4);
  assert.equal(change, "flat");
  assert.equal(priorPhase, "flat");
});

test("hourSlotAverageVolume averages only the same slot, only sessions strictly before the target", () => {
  const bars = [
    { sessionDate: "2026-09-08", slotIndex: 1, volume: 1000 },
    { sessionDate: "2026-09-08", slotIndex: 2, volume: 9999 }, // different slot -- excluded
    { sessionDate: "2026-09-09", slotIndex: 1, volume: 2000 },
    { sessionDate: "2026-09-10", slotIndex: 1, volume: 3000 }, // the target's own session -- excluded
  ];
  const target = { sessionDate: "2026-09-10", slotIndex: 1 };
  assert.equal(hourSlotAverageVolume(bars, target, 15), (1000 + 2000) / 2);
});

test("hourSlotAverageVolume only uses the trailing `lookbackSessions` prior sessions, not the whole history", () => {
  const bars = [
    { sessionDate: "2026-09-01", slotIndex: 0, volume: 100 }, // outside the 2-session lookback
    { sessionDate: "2026-09-02", slotIndex: 0, volume: 200 },
    { sessionDate: "2026-09-03", slotIndex: 0, volume: 400 },
  ];
  const target = { sessionDate: "2026-09-04", slotIndex: 0 };
  assert.equal(hourSlotAverageVolume(bars, target, 2), (200 + 400) / 2);
});

test("hourSlotAverageVolume returns null (never a guess) when there is no prior same-slot session", () => {
  const bars = [{ sessionDate: "2026-09-10", slotIndex: 3, volume: 500 }];
  const target = { sessionDate: "2026-09-10", slotIndex: 1 }; // different slot, and not strictly before
  assert.equal(hourSlotAverageVolume(bars, target, 15), null);
});

test("adx: +DI/-DI stabilize after `period` bars, but ADX itself needs another full period of DX (2*period total)", () => {
  const { highs, lows, closes } = trendingBars(20, 1); // > 14 (period) but < 28 (2*period)
  const result = adx(highs, lows, closes, 14);
  assert.notEqual(result.plusDI, null);
  assert.notEqual(result.minusDI, null);
  assert.equal(result.adx, null); // ADX itself isn't seeded yet
});

test("adx returns nulls for everything with fewer than `period` bars", () => {
  const { highs, lows, closes } = trendingBars(10, 1);
  const result = adx(highs, lows, closes, 14);
  assert.equal(result.adx, null);
  assert.equal(result.plusDI, null);
  assert.equal(result.minusDI, null);
});

test("adx becomes available once 2*period bars exist", () => {
  const { highs, lows, closes } = trendingBars(30, 1);
  const result = adx(highs, lows, closes, 14);
  assert.notEqual(result.adx, null);
  assert.notEqual(result.plusDI, null);
  assert.notEqual(result.minusDI, null);
});

test("adx: a clean, steady uptrend shows +DI clearly above -DI", () => {
  const { highs, lows, closes } = trendingBars(60, 2);
  const result = adx(highs, lows, closes, 14);
  assert.ok(result.plusDI > result.minusDI, `expected +DI (${result.plusDI}) > -DI (${result.minusDI})`);
});

test("adx: a clean, steady downtrend shows -DI clearly above +DI", () => {
  const { highs, lows, closes } = trendingBars(60, -2);
  const result = adx(highs, lows, closes, 14);
  assert.ok(result.minusDI > result.plusDI, `expected -DI (${result.minusDI}) > +DI (${result.plusDI})`);
});

test("adx: a strong sustained trend produces a materially higher ADX than a choppy, directionless series", () => {
  const trending = trendingBars(60, 2);
  const choppy = choppyBars(60);
  const trendingAdx = adx(trending.highs, trending.lows, trending.closes, 14).adx;
  const choppyAdx = adx(choppy.highs, choppy.lows, choppy.closes, 14).adx;
  assert.ok(trendingAdx !== null && choppyAdx !== null);
  assert.ok(trendingAdx > choppyAdx, `expected trending ADX (${trendingAdx}) > choppy ADX (${choppyAdx})`);
});

test("adx values stay within the valid 0-100 range", () => {
  const { highs, lows, closes } = trendingBars(60, 2);
  const result = adx(highs, lows, closes, 14);
  for (const v of [result.plusDI, result.minusDI, result.adx]) {
    assert.ok(v >= 0 && v <= 100, `expected value in [0,100], got ${v}`);
  }
});

/** Concatenates fixture bar series end-to-end, for slope tests that need a regime change. */
function concatBars(...seriesList) {
  return seriesList.reduce(
    (acc, s) => ({ highs: [...acc.highs, ...s.highs], lows: [...acc.lows, ...s.lows], closes: [...acc.closes, ...s.closes] }),
    { highs: [], lows: [], closes: [] }
  );
}

test("adxSlope returns null before enough ADX history exists", () => {
  const { highs, lows, closes } = trendingBars(10, 1);
  assert.equal(adxSlope(highs, lows, closes, 14), null);
});

test("adxSlope reads 'flat' for a pure, single-direction trend once ADX has seeded", () => {
  const { highs, lows, closes } = trendingBars(60, 2);
  assert.equal(adxSlope(highs, lows, closes, 14), "flat");
});

test("adxSlope reads 'rising' when a choppy period gives way to a strong sustained trend", () => {
  const { highs, lows, closes } = concatBars(choppyBars(45), trendingBars(20, 3));
  assert.equal(adxSlope(highs, lows, closes, 14), "rising");
});

test("adxSlope reads 'falling' when a strong trend decays into a choppy, directionless period", () => {
  const { highs, lows, closes } = concatBars(trendingBars(45, 3), choppyBars(20));
  assert.equal(adxSlope(highs, lows, closes, 14), "falling");
});

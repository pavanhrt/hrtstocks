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
} from "./indicators.js";

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

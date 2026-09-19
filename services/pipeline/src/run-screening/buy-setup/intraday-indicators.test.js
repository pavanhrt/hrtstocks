import { test } from "node:test";
import assert from "node:assert/strict";
import { computeIntradayIndicators } from "./intraday-indicators.js";

const PARAMS = {
  rsiPeriod: 14,
  stochasticLookback: 14,
  stochasticSmoothing: 3,
  bollingerLookback: 20,
  bollingerDeviation: 2.0,
  adxDmiPeriod: 14,
  macdFast: 12,
  macdSlow: 26,
  macdSignal: 9,
};

function bar(ts, close) {
  return { ts, date: ts, open: close, high: close + 1, low: close - 1, close, volume: 1000 };
}

test("empty bars -> every field NO_DATA/null, never a fabricated reading", () => {
  const result = computeIntradayIndicators([], PARAMS);
  assert.equal(result.rsi, null);
  assert.equal(result.bollingerStatus, "NO_DATA");
  assert.equal(result.macdHistogram, null);
});

test("with enough flat bars, Bollinger status reads within_bands and RSI/MACD/DMI resolve to finite numbers", () => {
  const bars = Array.from({ length: 40 }, (_, i) => bar(`t${i}`, 100 + Math.sin(i / 3)));
  const result = computeIntradayIndicators(bars, PARAMS);
  assert.equal(result.bollingerStatus, "within_bands");
  assert.ok(Number.isFinite(result.rsi));
  assert.equal(result.evidenceCandleTs, "t39");
});

test("a close pushed above the upper Bollinger band reads above_upper", () => {
  const bars = Array.from({ length: 25 }, (_, i) => bar(`t${i}`, 100));
  bars.push(bar("spike", 130));
  const result = computeIntradayIndicators(bars, PARAMS);
  assert.equal(result.bollingerStatus, "above_upper");
});

test("insufficient bars for the slow indicators still returns rather than throwing, with those fields null", () => {
  const bars = Array.from({ length: 5 }, (_, i) => bar(`t${i}`, 100 + i));
  const result = computeIntradayIndicators(bars, PARAMS);
  assert.equal(result.adx, null);
  assert.equal(result.macdHistogram, null);
});

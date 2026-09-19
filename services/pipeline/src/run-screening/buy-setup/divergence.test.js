import { test } from "node:test";
import assert from "node:assert/strict";
import { detectRsiBullishDivergence, detectMacdBullishDivergence } from "./divergence.js";

function seg(start, end, n) {
  const step = (end - start) / n;
  return Array.from({ length: n }, (_, i) => start + step * (i + 1));
}
function barsFromCloses(closes) {
  return closes.map((c, i) => ({ date: `d${i}`, open: c, high: c + 0.5, low: c - 0.5, close: c, volume: 1000 }));
}

const PARAMS = { rsiPeriod: 14, pivotLeftWindow: 3, pivotRightWindow: 3, lookback: 60 };
const MACD_PARAMS = { macdFast: 12, macdSlow: 26, macdSignal: 9, pivotLeftWindow: 3, pivotRightWindow: 3, lookback: 60 };

// Verified via a scratch script: two confirmed price-low pivots at index 29
// (79.5) and index 49 (77.5) -- price makes a lower low. The second leg down
// is SHALLOWER/slower than the first, so RSI(14) reads higher at the second
// low (~24.9) than the first (~8.3) -- a textbook regular bullish divergence.
function divergenceBars() {
  return barsFromCloses([...seg(96, 100, 20), ...seg(100, 80, 10), ...seg(80, 95, 6), ...seg(95, 78, 14), ...seg(78, 86, 6)]);
}

// Second leg down is SHARPER and reaches a lower absolute low -- momentum
// (RSI) also makes a lower low, so there is no divergence.
function noDivergenceBars() {
  return barsFromCloses([...seg(96, 100, 20), ...seg(100, 90, 10), ...seg(90, 98, 6), ...seg(98, 70, 14), ...seg(70, 80, 6)]);
}

// Second leg does NOT make a lower low at all (ends above the first low) --
// there is no bearish-price setup for a bullish divergence to resolve.
function notApplicableBars() {
  return barsFromCloses([...seg(96, 100, 20), ...seg(100, 80, 10), ...seg(80, 95, 6), ...seg(95, 85, 14), ...seg(85, 92, 6)]);
}

test("RSI bullish divergence: confirmed lower low in price + confirmed higher low in RSI -> PASS", () => {
  const result = detectRsiBullishDivergence(divergenceBars(), PARAMS);
  assert.equal(result.result, "PASS");
  assert.equal(result.indicator, "rsi");
  assert.ok(result.pricePivot2.price < result.pricePivot1.price);
  assert.ok(result.indicatorPivot2Value > result.indicatorPivot1Value);
});

test("RSI bullish divergence: price lower low but RSI also lower (momentum confirms) -> FAIL, not PASS", () => {
  const result = detectRsiBullishDivergence(noDivergenceBars(), PARAMS);
  assert.equal(result.result, "FAIL");
});

test("RSI bullish divergence: price does not make a lower low -> NOT_APPLICABLE, not FAIL", () => {
  const result = detectRsiBullishDivergence(notApplicableBars(), PARAMS);
  assert.equal(result.result, "NOT_APPLICABLE");
});

test("RSI bullish divergence: insufficient pivots -> NO_DATA, never a guess", () => {
  const shortBars = barsFromCloses(seg(100, 90, 10));
  const result = detectRsiBullishDivergence(shortBars, PARAMS);
  assert.equal(result.result, "NO_DATA");
});

test("MACD-histogram bullish divergence evaluated independently of RSI (same price shape, separate indicator series)", () => {
  const result = detectMacdBullishDivergence(divergenceBars(), MACD_PARAMS);
  assert.equal(result.indicator, "macd_histogram");
  // Whatever the MACD-specific verdict is, it must be one of the four
  // documented statuses and must be computed from the MACD histogram series,
  // not copied from the RSI result.
  assert.ok(["PASS", "FAIL", "NOT_APPLICABLE", "NO_DATA"].includes(result.result));
  const rsiResult = detectRsiBullishDivergence(divergenceBars(), PARAMS);
  assert.notEqual(result.indicatorPivot1Value, rsiResult.indicatorPivot1Value);
});

test("look-ahead prevention: the two most recent DIVERGENCE pivots are never the last (unconfirmed) bars", () => {
  const bars = divergenceBars();
  const result = detectRsiBullishDivergence(bars, PARAMS);
  assert.ok(result.pricePivot2.index <= bars.length - 1 - PARAMS.pivotRightWindow);
});

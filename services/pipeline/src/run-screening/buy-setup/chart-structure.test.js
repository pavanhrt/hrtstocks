import { test } from "node:test";
import assert from "node:assert/strict";
import { findConfirmedPivots, groupIntoLevels, detectSupportResistance, detectBreakout, detectChannel } from "./chart-structure.js";

function bar(date, high, low, close = (high + low) / 2, volume = 1000) {
  return { date, open: close, high, low, close, volume };
}

test("findConfirmedPivots confirms a fractal high with enough bars on both sides, and never reports one inside rightWindow of the end (no look-ahead)", () => {
  const highs = [1, 2, 3, 4, 5, 4, 3, 2, 1, 2, 3];
  const bars = highs.map((h, i) => bar(`d${i}`, h, h - 5));
  const { highs: confirmedHighs } = findConfirmedPivots(bars, 2, 2);
  assert.ok(confirmedHighs.some((p) => p.index === 4 && p.price === 5));
  for (const p of confirmedHighs) {
    assert.ok(p.index <= bars.length - 1 - 2, `pivot at index ${p.index} must have rightWindow bars confirmed after it`);
  }
  assert.ok(!confirmedHighs.some((p) => p.index === 10), "the last bar can never be a confirmed pivot -- no future bars exist to confirm it");
});

test("findConfirmedPivots confirms a fractal low symmetrically", () => {
  const lows = [10, 9, 8, 7, 6, 7, 8, 9, 10];
  const bars = lows.map((l, i) => bar(`d${i}`, l + 5, l));
  const { lows: confirmedLows } = findConfirmedPivots(bars, 2, 2);
  assert.ok(confirmedLows.some((p) => p.index === 4 && p.price === 6));
});

test("groupIntoLevels: nearby pivots merge into one level and only levels meeting minTouches survive", () => {
  const pivots = [
    { index: 0, date: "a", price: 100 },
    { index: 1, date: "b", price: 100.2 },
    { index: 2, date: "c", price: 100.1 },
    { index: 3, date: "d", price: 150 }, // isolated -- only 1 touch
  ];
  const levels = groupIntoLevels(pivots, 0.005, 2);
  assert.equal(levels.length, 1);
  assert.equal(levels[0].touchCount, 3);
  assert.ok(Math.abs(levels[0].level - 100.1) < 0.5);
});

const SR_PARAMS = { pivotLeftWindow: 2, pivotRightWindow: 2, tolerance: 0.005, minTouches: 2 };

test("detectSupportResistance: finds nearest confirmed support below and resistance above the last close", () => {
  // Two touches of resistance around 120, two touches of support around 90,
  // last close sits between them.
  const highSeq = [100, 105, 110, 115, 120, 115, 110, 105, 100, 105, 110, 115, 120, 115, 110, 105, 100];
  const lowSeq = [90, 92, 94, 92, 90, 92, 94, 96, 90, 92, 94, 92, 90, 92, 94, 96, 98];
  const bars = highSeq.map((h, i) => bar(`d${i}`, h, lowSeq[i], (h + lowSeq[i]) / 2));
  const { support, resistance } = detectSupportResistance(bars, SR_PARAMS);
  assert.ok(resistance, "expected a confirmed resistance level");
  assert.ok(resistance.level > bars[bars.length - 1].close);
  assert.ok(support, "expected a confirmed support level");
  assert.ok(support.level < bars[bars.length - 1].close);
});

test("detectSupportResistance: returns nulls (not fabricated levels) when there are too few bars", () => {
  const bars = [bar("a", 105, 95), bar("b", 106, 96)];
  const result = detectSupportResistance(bars, SR_PARAMS);
  assert.equal(result.support, null);
  assert.equal(result.resistance, null);
});

const BREAKOUT_PARAMS = { breakoutBuffer: 0.005, volumeLookback: 20, volumeMultiplier: 1.0 };

test("detectBreakout: close clearing resistance on above-average volume is a confirmed breakout", () => {
  const bars = Array.from({ length: 21 }, (_, i) => bar(`d${i}`, 101, 99, 100, 1000));
  bars.push(bar("breakout", 112, 100, 111, 5000));
  const result = detectBreakout(bars, 105, BREAKOUT_PARAMS);
  assert.equal(result.breakoutDetected, true);
  assert.equal(result.breakoutVolumeConfirmed, true);
  assert.equal(result.breakoutCandleDate, "breakout");
});

test("detectBreakout: close clearing resistance WITHOUT above-average volume is not volume-confirmed", () => {
  const bars = Array.from({ length: 21 }, (_, i) => bar(`d${i}`, 101, 99, 100, 1000));
  bars.push(bar("breakout", 112, 100, 111, 1000));
  const result = detectBreakout(bars, 105, BREAKOUT_PARAMS);
  assert.equal(result.breakoutDetected, true);
  assert.equal(result.breakoutVolumeConfirmed, false);
});

test("detectBreakout: no resistance level -> nulls, never a guess", () => {
  const bars = Array.from({ length: 21 }, (_, i) => bar(`d${i}`, 101, 99, 100));
  const result = detectBreakout(bars, null, BREAKOUT_PARAMS);
  assert.equal(result.breakoutDetected, null);
});

test("detectChannel: rising highs and lows classify as a rising channel with computed boundaries", () => {
  const highs = Array.from({ length: 5 }, (_, i) => ({ index: i * 3, price: 100 + i * 10 }));
  const lows = Array.from({ length: 5 }, (_, i) => ({ index: i * 3 + 1, price: 90 + i * 10 }));
  const result = detectChannel(highs, lows, 20, { minPivots: 4, slopeThreshold: 0.001 });
  assert.equal(result.type, "rising");
  assert.ok(result.upper > result.lower);
});

test("detectChannel: falling highs and lows classify as a falling channel", () => {
  const highs = Array.from({ length: 5 }, (_, i) => ({ index: i * 3, price: 200 - i * 10 }));
  const lows = Array.from({ length: 5 }, (_, i) => ({ index: i * 3 + 1, price: 180 - i * 10 }));
  const result = detectChannel(highs, lows, 20, { minPivots: 4, slopeThreshold: 0.001 });
  assert.equal(result.type, "falling");
});

test("detectChannel: flat highs and lows classify as sideways", () => {
  const highs = Array.from({ length: 5 }, (_, i) => ({ index: i * 3, price: 110 + (i % 2) * 0.01 }));
  const lows = Array.from({ length: 5 }, (_, i) => ({ index: i * 3 + 1, price: 90 + (i % 2) * 0.01 }));
  const result = detectChannel(highs, lows, 20, { minPivots: 4, slopeThreshold: 0.001 });
  assert.equal(result.type, "sideways");
});

test("detectChannel: too few confirmed pivots -> NOT_APPLICABLE, never a guessed direction", () => {
  const highs = [{ index: 0, price: 100 }];
  const lows = [{ index: 1, price: 90 }];
  const result = detectChannel(highs, lows, 20, { minPivots: 4, slopeThreshold: 0.001 });
  assert.equal(result.type, "NOT_APPLICABLE");
  assert.equal(result.upper, null);
});

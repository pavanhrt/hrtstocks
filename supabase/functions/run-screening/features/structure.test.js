import { test } from "node:test";
import assert from "node:assert/strict";
import { aggregateBars, zigzagPivots, zigzagPivotsWithUnconfirmedLeg, classifyDowStructure, rangeBreakoutWithVolume, labelPivotSequence } from "./structure.js";

function bar(date, open, high, low, close, volume = 1000) {
  return { date, open, high, low, close, volume };
}

test("aggregateBars groups daily bars into weekly OHLCV (first open, max high, min low, last close, summed volume)", () => {
  const daily = [
    bar("2026-01-05", 100, 105, 99, 102, 1000), // Monday
    bar("2026-01-06", 102, 108, 101, 107, 1200),
    bar("2026-01-07", 107, 110, 106, 109, 900),
    bar("2026-01-12", 110, 112, 108, 111, 1100), // next week
  ];
  const weekly = aggregateBars(daily, "weekly");
  assert.equal(weekly.length, 2);
  assert.equal(weekly[0].open, 100);
  assert.equal(weekly[0].high, 110);
  assert.equal(weekly[0].low, 99);
  assert.equal(weekly[0].close, 109);
  assert.equal(weekly[0].volume, 3100);
  assert.equal(weekly[1].open, 110);
});

test("aggregateBars groups daily bars into monthly OHLCV", () => {
  const daily = [
    bar("2026-01-05", 100, 105, 99, 102),
    bar("2026-01-20", 102, 115, 101, 110),
    bar("2026-02-02", 110, 111, 105, 108),
  ];
  const monthly = aggregateBars(daily, "monthly");
  assert.equal(monthly.length, 2);
  assert.equal(monthly[0].high, 115);
  assert.equal(monthly[0].close, 110);
  assert.equal(monthly[1].close, 108);
});

test("zigzagPivots finds at most the starting pivot when price never retraces past the threshold", () => {
  const bars = Array.from({ length: 5 }, (_, i) => bar(`d${i}`, 100 + i, 101 + i, 99 + i, 100 + i));
  // Too little cumulative movement (and too few bars) to clear a 50% threshold at all.
  assert.deepEqual(zigzagPivots(bars, 0.5), []);
});

test("zigzagPivots confirms a swing high once price retraces the threshold", () => {
  const up = Array.from({ length: 10 }, (_, i) => bar(`u${i}`, 100 + i * 2, 101 + i * 2, 99 + i * 2, 100 + i * 2));
  const down = Array.from({ length: 10 }, (_, i) => bar(`d${i}`, 118 - i * 3, 119 - i * 3, 117 - i * 3, 118 - i * 3));
  const pivots = zigzagPivots([...up, ...down], 0.05);
  assert.ok(pivots.some((p) => p.type === "high"));
});

test("classifyDowStructure returns ambiguous with fewer than 2 pivots of each type", () => {
  const result = classifyDowStructure([{ type: "high", index: 0, price: 100, date: "d0" }], 105);
  assert.equal(result.state, "ambiguous");
});

test("classifyDowStructure recognizes an intact uptrend (HH + HL, close above last HL)", () => {
  const pivots = [
    { type: "low", index: 0, price: 90, date: "d0" },
    { type: "high", index: 1, price: 100, date: "d1" },
    { type: "low", index: 2, price: 95, date: "d2" },
    { type: "high", index: 3, price: 110, date: "d3" },
  ];
  const result = classifyDowStructure(pivots, 105);
  assert.equal(result.state, "uptrend_intact");
});

test("classifyDowStructure recognizes an intact downtrend (LH + LL, close below last LH)", () => {
  const pivots = [
    { type: "high", index: 0, price: 110, date: "d0" },
    { type: "low", index: 1, price: 95, date: "d1" },
    { type: "high", index: 2, price: 105, date: "d2" },
    { type: "low", index: 3, price: 90, date: "d3" },
  ];
  const result = classifyDowStructure(pivots, 100);
  assert.equal(result.state, "downtrend_intact");
});

test("classifyDowStructure recognizes a confirmed bullish reversal", () => {
  const pivots = [
    { type: "high", index: 0, price: 110, date: "d0" },
    { type: "low", index: 1, price: 95, date: "d1" },
    { type: "high", index: 2, price: 105, date: "d2" }, // last LH
    { type: "low", index: 3, price: 100, date: "d3" }, // new HL above last LL (95)
  ];
  const result = classifyDowStructure(pivots, 108); // close above last LH (105)
  assert.equal(result.state, "confirmed_reversal_bullish");
});

test("rangeBreakoutWithVolume flags an upside breakout on above-average volume", () => {
  const bars = Array.from({ length: 21 }, (_, i) => bar(`d${i}`, 100, 101, 99, 100, 1000));
  bars.push(bar("breakout", 100, 112, 100, 111, 5000));
  const structure = { lastSwingHigh: 105, lastSwingLow: 95 };
  const result = rangeBreakoutWithVolume(structure, bars, 20, 1.0);
  assert.equal(result.up, true);
  assert.equal(result.down, false);
});

test("rangeBreakoutWithVolume returns nulls without a full volume-lookback window", () => {
  const bars = Array.from({ length: 5 }, (_, i) => bar(`d${i}`, 100, 101, 99, 100));
  const result = rangeBreakoutWithVolume({ lastSwingHigh: 105, lastSwingLow: 95 }, bars, 20, 1.0);
  assert.equal(result.up, null);
  assert.equal(result.down, null);
});

test("labelPivotSequence labels the first high/low as sequence origin, then HH/HL/LH/LL against the prior same-type pivot", () => {
  const pivots = [
    { type: "low", index: 0, price: 90, date: "d0" },
    { type: "high", index: 1, price: 100, date: "d1" },
    { type: "low", index: 2, price: 95, date: "d2" }, // higher than 90 -> HL
    { type: "high", index: 3, price: 110, date: "d3" }, // higher than 100 -> HH
    { type: "low", index: 4, price: 92, date: "d4" }, // lower than 95 -> LL
    { type: "high", index: 5, price: 105, date: "d5" }, // lower than 110 -> LH
  ];
  const labeled = labelPivotSequence(pivots);
  assert.deepEqual(
    labeled.map((p) => p.type),
    ["L", "H", "HL", "HH", "LL", "LH"]
  );
  assert.equal(labeled[0].price, 90);
  assert.equal(labeled[0].date, "d0");
});

test("labelPivotSequence labels a within-tolerance repeat as an explicit EH/EL (equal), not a manufactured HH/HL", () => {
  const highs = [
    { type: "high", index: 0, price: 100, date: "d0" },
    { type: "high", index: 1, price: 100.2, date: "d1" }, // within 0.5% tolerance
  ];
  assert.equal(labelPivotSequence(highs, 0.005)[1].type, "EH");

  const lows = [
    { type: "low", index: 0, price: 100, date: "d0" },
    { type: "low", index: 1, price: 100.2, date: "d1" },
  ];
  assert.equal(labelPivotSequence(lows, 0.005)[1].type, "EL");
});

test("zigzagPivotsWithUnconfirmedLeg exposes the current forming leg without it becoming a confirmed pivot", () => {
  const bars = [
    bar("d0", 100, 101, 99, 100),
    bar("d1", 102, 103, 101, 102),
    bar("d2", 104, 108, 103, 104), // clears the 5% threshold from bars[0].low -> confirms a low pivot, trendDir='up'
    bar("d3", 106, 112, 111, 112), // new high, but retrace from it is under 5% -- not confirmed yet
  ];
  const { confirmed, unconfirmedLeg } = zigzagPivotsWithUnconfirmedLeg(bars, 0.05);
  assert.equal(confirmed.length, 1);
  assert.equal(confirmed[0].type, "low");
  assert.equal(confirmed[0].price, 99);
  assert.deepEqual(unconfirmedLeg, { type: "high", price: 112, date: "d3" });

  // zigzagPivots (the existing, unchanged export) must return exactly the same confirmed pivots.
  assert.deepEqual(zigzagPivots(bars, 0.05), confirmed);
});

test("zigzagPivotsWithUnconfirmedLeg mirrors for a downtrend", () => {
  const bars = [
    bar("d0", 118, 119, 117, 118),
    bar("d1", 116, 117, 115, 116),
    bar("d2", 114, 115, 110, 111), // clears 5% down from bars[0].high -> confirms a high pivot, trendDir='down'
    bar("d3", 109, 110, 106, 107), // new low, but retrace under 5% -- not confirmed yet
  ];
  const { confirmed, unconfirmedLeg } = zigzagPivotsWithUnconfirmedLeg(bars, 0.05);
  assert.equal(confirmed.length, 1);
  assert.equal(confirmed[0].type, "high");
  assert.deepEqual(unconfirmedLeg, { type: "low", price: 106, date: "d3" });
});

test("zigzagPivotsWithUnconfirmedLeg returns unconfirmedLeg=null before any pivot has confirmed", () => {
  const bars = [bar("d0", 100, 101, 99, 100), bar("d1", 100.2, 101.2, 99.2, 100.2)];
  const { confirmed, unconfirmedLeg } = zigzagPivotsWithUnconfirmedLeg(bars, 0.05);
  assert.equal(confirmed.length, 0);
  assert.equal(unconfirmedLeg, null);
});

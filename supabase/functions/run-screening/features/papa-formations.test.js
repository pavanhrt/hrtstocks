import { test } from "node:test";
import assert from "node:assert/strict";
import { detectCounterAttack, detectGap, detectGenuineBreak, detectFakeBreak, detectMotherCandle, detectTriggeredPapaFormations } from "./papa-formations.js";

function hbar({ date, sessionDate, slotIndex, low, high, close, open, volume = 1000 }) {
  return { date, sessionDate, slotIndex, low, high, close, open: open ?? close, volume };
}

// --- detectCounterAttack ---

test("detectCounterAttack (bullish): opens below support, re-enters and a follow-up candle confirms -- TRIGGERED", () => {
  const hourlyPivots = [{ type: "low", price: 100, date: "X" }];
  const bars = [
    hbar({ date: "A0", sessionDate: "2026-09-10", slotIndex: 0, low: 97, high: 99, close: 97, open: 98 }),
    hbar({ date: "A1", sessionDate: "2026-09-10", slotIndex: 1, low: 97, high: 102, close: 101, open: 97 }),
  ];
  const result = detectCounterAttack(bars, hourlyPivots, [], true);
  assert.equal(result.length, 1);
  assert.equal(result[0].patternName, "Bulls Counter Attack");
  assert.equal(result[0].state, "TRIGGERED");
  assert.equal(result[0].triggerBarDate, "A1");
});

test("detectCounterAttack (bearish mirror): re-enters below resistance on the open candle itself, but the follow-up candle fails to hold -- stays OBSERVED, never TRIGGERED", () => {
  const hourlyPivots = [{ type: "high", price: 100, date: "X" }];
  const bars = [
    hbar({ date: "A0", sessionDate: "2026-09-10", slotIndex: 0, low: 100, high: 102, close: 98, open: 102 }),
    hbar({ date: "A1", sessionDate: "2026-09-10", slotIndex: 1, low: 99, high: 103, close: 101, open: 99 }),
  ];
  const result = detectCounterAttack(bars, hourlyPivots, [], false);
  assert.equal(result.length, 1);
  assert.equal(result[0].patternName, "Bears Counter Attack");
  assert.equal(result[0].state, "OBSERVED");
  assert.equal(result[0].triggerBarDate, null);
});

test("detectCounterAttack: ignores an open candle that isn't the session's first (09:15) bar", () => {
  const hourlyPivots = [{ type: "low", price: 100, date: "X" }];
  const bars = [hbar({ date: "A0", sessionDate: "2026-09-10", slotIndex: 2, low: 97, high: 99, close: 97, open: 98 })];
  assert.deepEqual(detectCounterAttack(bars, hourlyPivots, [], true), []);
});

// --- detectGap ---

test("detectGap (bullish): opens above resistance, sustains through the open candle, follow-up confirms -- TRIGGERED", () => {
  const hourlyPivots = [{ type: "high", price: 100, date: "X" }];
  const bars = [
    hbar({ date: "A0", sessionDate: "2026-09-10", slotIndex: 0, low: 102, high: 104, close: 103, open: 103 }),
    hbar({ date: "A1", sessionDate: "2026-09-10", slotIndex: 1, low: 102, high: 105, close: 104, open: 103 }),
  ];
  const result = detectGap(bars, hourlyPivots, [], true);
  assert.equal(result.length, 1);
  assert.equal(result[0].patternName, "Gap Up");
  assert.equal(result[0].state, "TRIGGERED");
});

test("detectGap: the gap is given back within the opening candle itself -- not this setup at all", () => {
  const hourlyPivots = [{ type: "high", price: 100, date: "X" }];
  const bars = [hbar({ date: "A0", sessionDate: "2026-09-10", slotIndex: 0, low: 97, high: 104, close: 99, open: 103 })];
  assert.deepEqual(detectGap(bars, hourlyPivots, [], true), []);
});

// --- detectGenuineBreak ---

test("detectGenuineBreak (bullish): a shakeout precedes the real break, follow-up candle confirms -- TRIGGERED", () => {
  const hourlyPivots = [{ type: "high", price: 100, date: "X" }];
  const bars = [
    hbar({ date: "A0", sessionDate: "2026-09-10", slotIndex: 0, low: 95, high: 101, close: 96, open: 95 }), // shakeout: wick above 100, closes back below
    hbar({ date: "A1", sessionDate: "2026-09-10", slotIndex: 1, low: 96, high: 98, close: 97, open: 96 }),
    hbar({ date: "A2", sessionDate: "2026-09-10", slotIndex: 2, low: 97, high: 103, close: 102, open: 97 }), // the real break
    hbar({ date: "A3", sessionDate: "2026-09-10", slotIndex: 3, low: 101, high: 105, close: 104, open: 102 }), // follow-up confirms
  ];
  const result = detectGenuineBreak(bars, hourlyPivots, [], true);
  assert.equal(result.length, 1);
  assert.equal(result[0].patternName, "Genuine Breakout");
  assert.equal(result[0].state, "TRIGGERED");
  assert.equal(result[0].triggerBarDate, "A3");
});

test("detectGenuineBreak: a break with no prior shakeout is not reported by this detector at all (that's Fake, not Genuine)", () => {
  const hourlyPivots = [{ type: "high", price: 100, date: "X" }];
  const bars = [
    hbar({ date: "A0", sessionDate: "2026-09-10", slotIndex: 0, low: 96, high: 98, close: 97, open: 96 }), // no shakeout
    hbar({ date: "A1", sessionDate: "2026-09-10", slotIndex: 1, low: 97, high: 99, close: 98, open: 97 }),
    hbar({ date: "A2", sessionDate: "2026-09-10", slotIndex: 2, low: 97, high: 103, close: 102, open: 97 }),
    hbar({ date: "A3", sessionDate: "2026-09-10", slotIndex: 3, low: 101, high: 105, close: 104, open: 102 }),
  ];
  assert.deepEqual(detectGenuineBreak(bars, hourlyPivots, [], true), []);
});

// --- detectFakeBreak ---

test("detectFakeBreak (bullish -- 'a fake breakdown is a BUY setup'): no shakeout before the breakdown, follow-up closes above the breakdown candle's own high -- TRIGGERED", () => {
  const hourlyPivots = [{ type: "low", price: 100, date: "X" }];
  const bars = [
    hbar({ date: "P0", sessionDate: "2026-09-09", slotIndex: 4, low: 99, high: 101, close: 100, open: 100 }),
    hbar({ date: "A0", sessionDate: "2026-09-10", slotIndex: 0, low: 98, high: 103, close: 98, open: 101 }), // breaks below 100, no shakeout
    hbar({ date: "A1", sessionDate: "2026-09-10", slotIndex: 1, low: 98, high: 105, close: 104, open: 99 }), // follow-up closes above A0's own high (103)
  ];
  const result = detectFakeBreak(bars, hourlyPivots, [], true);
  assert.equal(result.length, 1);
  assert.equal(result[0].patternName, "Fake Breakdown");
  assert.equal(result[0].direction, "bullish"); // the documented asymmetry: a fake BREAKDOWN is a bullish setup
  assert.equal(result[0].state, "TRIGGERED");
});

// --- detectMotherCandle ---

test("detectMotherCandle (bullish reversal at a level): a bigger candle at a detected support, 3 following candles stay inside its range, a later close beyond its high triggers", () => {
  const hourlyPivots = [{ type: "low", price: 95, date: "X" }];
  const bars = [
    hbar({ date: "P0", sessionDate: "2026-09-09", slotIndex: 4, low: 98, high: 100, close: 99, open: 98 }),
    hbar({ date: "M0", sessionDate: "2026-09-10", slotIndex: 0, low: 94, high: 105, close: 96, open: 104 }), // mother candle, low at the 95 level
    hbar({ date: "F0", sessionDate: "2026-09-10", slotIndex: 1, low: 95, high: 100, close: 97, open: 96 }),
    hbar({ date: "F1", sessionDate: "2026-09-10", slotIndex: 2, low: 96, high: 101, close: 98, open: 97 }),
    hbar({ date: "F2", sessionDate: "2026-09-10", slotIndex: 3, low: 97, high: 102, close: 100, open: 98 }),
    hbar({ date: "T0", sessionDate: "2026-09-10", slotIndex: 4, low: 100, high: 108, close: 107, open: 101 }), // trigger: close > mother's high (105)
  ];
  const result = detectMotherCandle(bars, hourlyPivots, [], true, true);
  assert.equal(result.length, 1);
  assert.equal(result[0].patternName, "Mother Candle -- bullish reversal");
  assert.equal(result[0].state, "TRIGGERED");
  assert.equal(result[0].triggerBarDate, "T0");
});

test("detectMotherCandle: a candle not bigger than the one before it is never reported as a mother candle", () => {
  const hourlyPivots = [{ type: "low", price: 95, date: "X" }];
  const bars = [
    hbar({ date: "P0", sessionDate: "2026-09-09", slotIndex: 4, low: 90, high: 106, close: 99, open: 95 }), // wide -- bigger than the next bar
    hbar({ date: "M0", sessionDate: "2026-09-10", slotIndex: 0, low: 94, high: 96, close: 95, open: 95 }), // NOT bigger than P0
    hbar({ date: "F0", sessionDate: "2026-09-10", slotIndex: 1, low: 95, high: 96, close: 95, open: 95 }),
    hbar({ date: "F1", sessionDate: "2026-09-10", slotIndex: 2, low: 95, high: 96, close: 95, open: 95 }),
    hbar({ date: "F2", sessionDate: "2026-09-10", slotIndex: 3, low: 95, high: 96, close: 95, open: 95 }),
    hbar({ date: "T0", sessionDate: "2026-09-10", slotIndex: 4, low: 95, high: 99, close: 98, open: 96 }),
  ];
  assert.deepEqual(detectMotherCandle(bars, hourlyPivots, [], true, true), []);
});

// --- detectTriggeredPapaFormations (the M6/S6 gate's own entry point) ---

test("detectTriggeredPapaFormations returns only TRIGGERED detections, never merely OBSERVED ones", () => {
  const hourlyPivots = [{ type: "high", price: 100, date: "X" }];
  // Same OBSERVED-only bearish counter-attack fixture as above.
  const bars = [
    hbar({ date: "A0", sessionDate: "2026-09-10", slotIndex: 0, low: 100, high: 102, close: 98, open: 102 }),
    hbar({ date: "A1", sessionDate: "2026-09-10", slotIndex: 1, low: 99, high: 103, close: 101, open: 99 }),
  ];
  const result = detectTriggeredPapaFormations({ hourlyBars: bars, hourlyPivots, dailyPivots: [], bullish: false });
  assert.deepEqual(result, []); // the only formation present (Bears Counter Attack) is OBSERVED, not TRIGGERED
});

test("detectTriggeredPapaFormations returns an empty array, never null/undefined, when no bars are given", () => {
  const result = detectTriggeredPapaFormations({ hourlyBars: [], hourlyPivots: [], dailyPivots: [], bullish: true });
  assert.deepEqual(result, []);
});

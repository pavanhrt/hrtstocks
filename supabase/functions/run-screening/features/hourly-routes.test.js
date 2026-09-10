import { test } from "node:test";
import assert from "node:assert/strict";
import { detectWave3Ignition, detectWave2Pullback } from "./hourly-routes.js";

function hbar({ date, sessionDate, slotIndex, low, high, close, open, volume }) {
  return { date, sessionDate, slotIndex, low, high, close, open: open ?? close, volume };
}
function dbar(date, { low, high, close, open, volume = 100000 }) {
  return { date, low, high, close, open: open ?? close, volume };
}

// A clean bullish wave-3-forming shape, threshold 0.05, spanning 3 sessions:
//   origin (A0, 2026-09-08) -> wave1 H@121 (A3) -> wave2 L@108 (B4) ->
//   wave3 forming, trigger at C6 (2026-09-10, slot 2) closing at 123 > 121.
// bar A2 (2026-09-08, slot 2, low volume 300) is the prior same-hour-slot
// comparison for the trigger's hour-slot volume average.
function happyPathHourlyBars({ triggerVolume = 900, triggerSlot = 2 } = {}) {
  return [
    hbar({ date: "A0", sessionDate: "2026-09-08", slotIndex: 0, low: 100, high: 100, close: 100, volume: 500 }),
    hbar({ date: "A1", sessionDate: "2026-09-08", slotIndex: 1, low: 100, high: 100, close: 100, volume: 500 }),
    hbar({ date: "A2", sessionDate: "2026-09-08", slotIndex: 2, low: 100, high: 120, close: 118, open: 101, volume: 300 }),
    hbar({ date: "A3", sessionDate: "2026-09-08", slotIndex: 3, low: 113, high: 121, close: 115, open: 120, volume: 500 }),
    hbar({ date: "B4", sessionDate: "2026-09-09", slotIndex: 0, low: 108, high: 114, close: 110, open: 113, volume: 500 }),
    hbar({ date: "B5", sessionDate: "2026-09-09", slotIndex: 1, low: 112, high: 116, close: 115, open: 114, volume: 500 }),
    hbar({ date: "C6", sessionDate: "2026-09-10", slotIndex: triggerSlot, low: 121, high: 125, close: 123, open: 122, volume: triggerVolume }),
  ];
}

const FLAT_DAILY_BARS = [dbar("2026-09-01", { low: 119, high: 120, close: 119.5 }), dbar("2026-09-02", { low: 119, high: 120, close: 119.5 })];

test("detectWave3Ignition returns null when no wave-3-forming impulse shape is present at all", () => {
  const bars = [
    hbar({ date: "A0", sessionDate: "2026-09-08", slotIndex: 0, low: 100, high: 100, close: 100, volume: 500 }),
    hbar({ date: "A1", sessionDate: "2026-09-08", slotIndex: 1, low: 100, high: 100, close: 100, volume: 500 }),
  ];
  const result = detectWave3Ignition({
    hourlyBars: bars,
    dailyBars: FLAT_DAILY_BARS,
    bullish: true,
    hourlyZigzagPct: 0.05,
    dailyZigzagPct: 0.02,
    hourSlotVolumeLookbackSessions: 15,
  });
  assert.equal(result, null);
});

test("detectWave3Ignition: a clean setup with trigger, sufficient volume, and a clear rule-3 forward check all passes", () => {
  const result = detectWave3Ignition({
    hourlyBars: happyPathHourlyBars(),
    dailyBars: FLAT_DAILY_BARS, // no confirmed daily resistance -- rule-3 forward check auto-passes
    bullish: true,
    hourlyZigzagPct: 0.05,
    dailyZigzagPct: 0.02,
    hourSlotVolumeLookbackSessions: 15,
  });
  assert.ok(result);
  assert.equal(result.route, "BUY-1");
  assert.equal(result.wave1.price, 121);
  assert.equal(result.wave2.price, 108);
  assert.equal(result.origin.price, 100);
  assert.equal(result.trigger.close, 123);
  assert.equal(result.trigger.confirmed, true);
  assert.equal(result.trigger.gapOnly, false);
  assert.equal(result.volume.hourSlotAverage, 300);
  assert.equal(result.volume.triggerAboveHourSlotAverage, true);
  assert.equal(result.volume.wave1Volume, 1300); // bars A1+A2+A3: 500+300+500
  assert.equal(result.volume.wave3VolumeSoFar, 1400); // bars B5+C6: 500+900
  assert.equal(result.volume.wave3ExceedsWave1Volume, true);
  assert.equal(result.ruleThreeForwardCheck.passes, true);
  assert.equal(result.ruleThreeForwardCheck.minViableTarget, 129); // 108 + (121-100)
  assert.equal(result.requiredChecksPassed, true);
  assert.deepEqual(result.stops, { tight: 108, structural: 100 });
  assert.equal(result.targets.length, 3);
  assert.equal(result.targets[0], 108 + 1.62 * 21);
});

test("detectWave3Ignition: no trigger yet (price hasn't cleared wave 1) reports a forming state with trigger=null", () => {
  const bars = happyPathHourlyBars().slice(0, 6); // stop before C6, the trigger bar
  const result = detectWave3Ignition({
    hourlyBars: bars,
    dailyBars: FLAT_DAILY_BARS,
    bullish: true,
    hourlyZigzagPct: 0.05,
    dailyZigzagPct: 0.02,
    hourSlotVolumeLookbackSessions: 15,
  });
  assert.ok(result);
  assert.equal(result.state, "forming");
  assert.equal(result.trigger, null);
  assert.equal(result.volume, null);
  assert.equal(result.requiredChecksPassed, false);
});

test("detectWave3Ignition: a trigger that clears wave 1 only on the session's first candle, with the prior day's close still below wave 1, is gapOnly and not confirmed", () => {
  const bars = happyPathHourlyBars({ triggerSlot: 0 }); // C6 is now slot 0 -- the session's first candle
  const dailyBars = [...FLAT_DAILY_BARS, dbar("2026-09-09", { low: 110, high: 116, close: 115 })]; // prior session's close (115) is below wave 1 (121)
  const result = detectWave3Ignition({
    hourlyBars: bars,
    dailyBars,
    bullish: true,
    hourlyZigzagPct: 0.05,
    dailyZigzagPct: 0.02,
    hourSlotVolumeLookbackSessions: 15,
  });
  assert.equal(result.trigger.isFirstCandleOfSession, true);
  assert.equal(result.trigger.gapOnly, true);
  assert.equal(result.trigger.confirmed, false);
  assert.equal(result.volume, null); // volume is only computed once the trigger is actually confirmed
  assert.equal(result.requiredChecksPassed, false);
});

test("detectWave3Ignition: a first-candle trigger is NOT gapOnly when the prior session's close had already cleared wave 1", () => {
  const bars = happyPathHourlyBars({ triggerSlot: 0 });
  const dailyBars = [...FLAT_DAILY_BARS, dbar("2026-09-09", { low: 118, high: 124, close: 122 })]; // prior close (122) already above wave 1 (121)
  const result = detectWave3Ignition({
    hourlyBars: bars,
    dailyBars,
    bullish: true,
    hourlyZigzagPct: 0.05,
    dailyZigzagPct: 0.02,
    hourSlotVolumeLookbackSessions: 15,
  });
  assert.equal(result.trigger.gapOnly, false);
  assert.equal(result.trigger.confirmed, true);
});

test("detectWave3Ignition: fails the volume check when the trigger candle doesn't clear its hour-slot average", () => {
  const result = detectWave3Ignition({
    hourlyBars: happyPathHourlyBars({ triggerVolume: 100 }), // below the 300 hour-slot average
    dailyBars: FLAT_DAILY_BARS,
    bullish: true,
    hourlyZigzagPct: 0.05,
    dailyZigzagPct: 0.02,
    hourSlotVolumeLookbackSessions: 15,
  });
  assert.equal(result.volume.triggerAboveHourSlotAverage, false);
  assert.equal(result.requiredChecksPassed, false);
});

test("detectWave3Ignition: fails the rule-3 forward check when a nearby daily resistance sits below the minimum viable wave-3 target", () => {
  // A confirmed daily high pivot at 135 -- above the current price (123) but
  // below the minimum viable wave-3 target (129 + ... no, 108+21=129 < 135),
  // so the setup's own minimum target doesn't clear this resistance.
  const dailyBars = [
    dbar("2026-08-20", { low: 118, high: 119 }),
    dbar("2026-08-21", { low: 118, high: 135 }),
    dbar("2026-08-24", { low: 128, high: 134 }),
  ];
  const result = detectWave3Ignition({
    hourlyBars: happyPathHourlyBars(),
    dailyBars,
    bullish: true,
    hourlyZigzagPct: 0.05,
    dailyZigzagPct: 0.02,
    hourSlotVolumeLookbackSessions: 15,
  });
  assert.equal(result.ruleThreeForwardCheck.nearestDailyLevel.price, 135);
  assert.equal(result.ruleThreeForwardCheck.passes, false);
  assert.equal(result.requiredChecksPassed, false);
});

// Bearish mirror (SELL-3 "Wave 3-Down Ignition") -- same shape, flipped sign.
function happyPathBearishHourlyBars() {
  return [
    hbar({ date: "A0", sessionDate: "2026-09-08", slotIndex: 0, low: 100, high: 100, close: 100, volume: 500 }),
    hbar({ date: "A1", sessionDate: "2026-09-08", slotIndex: 1, low: 100, high: 100, close: 100, volume: 500 }),
    hbar({ date: "A2", sessionDate: "2026-09-08", slotIndex: 2, low: 80, high: 100, close: 82, open: 99, volume: 300 }),
    hbar({ date: "A3", sessionDate: "2026-09-08", slotIndex: 3, low: 79, high: 87, close: 85, open: 80, volume: 500 }),
    hbar({ date: "B4", sessionDate: "2026-09-09", slotIndex: 0, low: 86, high: 92, close: 90, open: 87, volume: 500 }),
    hbar({ date: "B5", sessionDate: "2026-09-09", slotIndex: 1, low: 84, high: 88, close: 85, open: 86, volume: 500 }),
    hbar({ date: "C6", sessionDate: "2026-09-10", slotIndex: 2, low: 76, high: 78, close: 77, open: 77.5, volume: 900 }),
  ];
}

test("detectWave3Ignition: bearish mirror (SELL-3) detects a symmetric wave-3-down-forming setup", () => {
  const result = detectWave3Ignition({
    hourlyBars: happyPathBearishHourlyBars(),
    dailyBars: FLAT_DAILY_BARS,
    bullish: false,
    hourlyZigzagPct: 0.05,
    dailyZigzagPct: 0.02,
    hourSlotVolumeLookbackSessions: 15,
  });
  assert.ok(result);
  assert.equal(result.route, "SELL-3");
  assert.equal(result.wave1.price, 79); // the low pivot wave 1 down confirms at
  assert.equal(result.wave2.price, 92); // the bounce (wave 2) pivot
  assert.equal(result.trigger.close, 77);
  assert.equal(result.trigger.confirmed, true);
  assert.equal(result.requiredChecksPassed, true);
});

// --- detectWave2Pullback (BUY-4 "Wave 2 Pullback" / SELL-4 "Bounce Failure") ---

// origin L@100 -> wave1 H@141 (confirmed) -> a still-forming pullback that
// declines gradually to a low of 120 (retracement fraction 0.512, inside
// the 38.2-61.8% band) with a Bullish Engulfing (B5->B6) confirmed TRIGGERED
// once the trailing 5-bar lookback genuinely reads "down" (the gradual
// decline through C4-C6 is what gets the local trend context right, unlike
// jumping straight from wave 1 to the pullback low).
function pullbackHourlyBars({ finalLow = 120, finalHigh = 125.5, finalClose = 125 } = {}) {
  return [
    hbar({ date: "A0", sessionDate: "2026-09-08", slotIndex: 0, low: 100, high: 100, close: 100, volume: 400 }),
    hbar({ date: "A1", sessionDate: "2026-09-08", slotIndex: 1, low: 100, high: 100, close: 100, volume: 400 }),
    hbar({ date: "A2", sessionDate: "2026-09-08", slotIndex: 2, low: 100, high: 140, close: 138, open: 101, volume: 400 }),
    hbar({ date: "A3", sessionDate: "2026-09-08", slotIndex: 3, low: 133, high: 141, close: 135, open: 140, volume: 400 }),
    hbar({ date: "C4", sessionDate: "2026-09-09", slotIndex: 0, low: 130, high: 134, close: 131, open: 133, volume: 400 }),
    hbar({ date: "C5", sessionDate: "2026-09-09", slotIndex: 1, low: 127, high: 131, close: 128, open: 130, volume: 400 }),
    hbar({ date: "C6", sessionDate: "2026-09-09", slotIndex: 2, low: 124, high: 128, close: 125, open: 127, volume: 400 }),
    hbar({ date: "B5", sessionDate: "2026-09-09", slotIndex: 3, low: 121, high: 125, close: 121.5, open: 124, volume: 400 }),
    hbar({ date: "B6", sessionDate: "2026-09-09", slotIndex: 4, low: finalLow, high: finalHigh, close: finalClose, open: 121, volume: 600 }),
  ];
}

test("detectWave2Pullback returns null when no wave-2-forming impulse shape is present at all", () => {
  const bars = [
    hbar({ date: "A0", sessionDate: "2026-09-08", slotIndex: 0, low: 100, high: 100, close: 100, volume: 400 }),
    hbar({ date: "A1", sessionDate: "2026-09-08", slotIndex: 1, low: 100, high: 100, close: 100, volume: 400 }),
  ];
  assert.equal(detectWave2Pullback({ hourlyBars: bars, bullish: true, hourlyZigzagPct: 0.05 }), null);
});

test("detectWave2Pullback: a retracement inside the Fib band with a TRIGGERED bullish reversal candle passes", () => {
  const result = detectWave2Pullback({ hourlyBars: pullbackHourlyBars(), bullish: true, hourlyZigzagPct: 0.05 });
  assert.ok(result);
  assert.equal(result.route, "BUY-4");
  assert.equal(result.origin.price, 100);
  assert.equal(result.wave1.price, 141);
  assert.equal(result.currentRetracementLevel, 120);
  assert.ok(Math.abs(result.retracementFraction - (141 - 120) / 41) < 1e-9);
  assert.equal(result.breachedOrigin, false);
  assert.equal(result.withinFibBand, true);
  assert.equal(result.trigger.patternName, "Bullish Engulfing");
  assert.equal(result.trigger.barDate, "B6");
  assert.equal(result.stop, 100); // below the origin of wave 1
  assert.equal(result.requiredChecksPassed, true);
});

test("detectWave2Pullback: a retracement that breaches wave 1's origin fails, even with a trigger pattern", () => {
  const result = detectWave2Pullback({ hourlyBars: pullbackHourlyBars({ finalLow: 95, finalHigh: 99, finalClose: 98 }), bullish: true, hourlyZigzagPct: 0.05 });
  assert.equal(result.breachedOrigin, true);
  assert.equal(result.withinFibBand, false);
  assert.equal(result.requiredChecksPassed, false);
});

test("detectWave2Pullback: a retracement outside the Fib band (too shallow) fails", () => {
  // A ~24% retrace from wave 1 (141) down to 131 -- nowhere near the 38.2-61.8% band.
  const shallowBars = [
    hbar({ date: "A0", sessionDate: "2026-09-08", slotIndex: 0, low: 100, high: 100, close: 100, volume: 400 }),
    hbar({ date: "A1", sessionDate: "2026-09-08", slotIndex: 1, low: 100, high: 100, close: 100, volume: 400 }),
    hbar({ date: "A2", sessionDate: "2026-09-08", slotIndex: 2, low: 100, high: 140, close: 138, open: 101, volume: 400 }),
    hbar({ date: "A3", sessionDate: "2026-09-08", slotIndex: 3, low: 133, high: 141, close: 135, open: 140, volume: 400 }),
    hbar({ date: "C4", sessionDate: "2026-09-09", slotIndex: 0, low: 132.5, high: 134, close: 133, open: 133.5, volume: 400 }),
    hbar({ date: "C5", sessionDate: "2026-09-09", slotIndex: 1, low: 132, high: 133.5, close: 132.5, open: 133, volume: 400 }),
    hbar({ date: "C6", sessionDate: "2026-09-09", slotIndex: 2, low: 131.5, high: 133, close: 132, open: 132.5, volume: 400 }),
    hbar({ date: "B5", sessionDate: "2026-09-09", slotIndex: 3, low: 131, high: 132.5, close: 131.5, open: 132, volume: 400 }),
  ];
  const result = detectWave2Pullback({ hourlyBars: shallowBars, bullish: true, hourlyZigzagPct: 0.05 });
  assert.ok(result);
  assert.ok(result.retracementFraction < 0.382);
  assert.equal(result.withinFibBand, false);
  assert.equal(result.requiredChecksPassed, false);
});

test("detectWave2Pullback: inside the Fib band but no reversal trigger pattern yet leaves requiredChecksPassed false", () => {
  const bars = pullbackHourlyBars().map((b) => (b.date === "B6" ? { ...b, open: 118, close: 119, high: 121 } : b)); // no longer an engulfing
  const result = detectWave2Pullback({ hourlyBars: bars, bullish: true, hourlyZigzagPct: 0.05 });
  assert.equal(result.withinFibBand, true);
  assert.equal(result.trigger, null);
  assert.equal(result.requiredChecksPassed, false);
});

// Bearish mirror (SELL-4 "Bounce Failure"): origin H@100 -> wave1 L@59
// (confirmed) -> a still-forming bounce rallying gradually to a high of 80
// (retracement fraction 0.512) with a Bearish Engulfing trigger.
function bounceFailureHourlyBars() {
  return [
    hbar({ date: "A0", sessionDate: "2026-09-08", slotIndex: 0, low: 100, high: 100, close: 100, volume: 400 }),
    hbar({ date: "A1", sessionDate: "2026-09-08", slotIndex: 1, low: 100, high: 100, close: 100, volume: 400 }),
    hbar({ date: "A2", sessionDate: "2026-09-08", slotIndex: 2, low: 60, high: 100, close: 62, open: 99, volume: 400 }),
    hbar({ date: "A3", sessionDate: "2026-09-08", slotIndex: 3, low: 59, high: 67, close: 65, open: 60, volume: 400 }),
    hbar({ date: "C4", sessionDate: "2026-09-09", slotIndex: 0, low: 68.5, high: 70, close: 69, open: 68.7, volume: 400 }),
    hbar({ date: "C5", sessionDate: "2026-09-09", slotIndex: 1, low: 71.5, high: 73, close: 72, open: 71.7, volume: 400 }),
    hbar({ date: "C6", sessionDate: "2026-09-09", slotIndex: 2, low: 74.5, high: 76, close: 75, open: 74.7, volume: 400 }),
    hbar({ date: "B5", sessionDate: "2026-09-09", slotIndex: 3, low: 77.5, high: 79, close: 78.7, open: 77.6, volume: 400 }), // bullish c1
    hbar({ date: "B6", sessionDate: "2026-09-09", slotIndex: 4, low: 76.5, high: 80, close: 77, open: 79.5, volume: 600 }), // bearish c2, engulfs c1
  ];
}

test("detectWave2Pullback: bearish mirror (SELL-4) detects a symmetric bounce-failure setup", () => {
  const result = detectWave2Pullback({ hourlyBars: bounceFailureHourlyBars(), bullish: false, hourlyZigzagPct: 0.05 });
  assert.ok(result);
  assert.equal(result.route, "SELL-4");
  assert.equal(result.wave1.price, 59);
  assert.equal(result.currentRetracementLevel, 80);
  assert.equal(result.withinFibBand, true);
  assert.equal(result.trigger.patternName, "Bearish Engulfing");
  assert.equal(result.stop, 80); // above the rally high -- NOT the wave-1 origin, unlike BUY-4
  assert.equal(result.requiredChecksPassed, true);
});

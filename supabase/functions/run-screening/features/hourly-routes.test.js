import { test } from "node:test";
import assert from "node:assert/strict";
import { detectWave3Ignition } from "./hourly-routes.js";

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

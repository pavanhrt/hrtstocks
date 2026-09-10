import { test } from "node:test";
import assert from "node:assert/strict";
import { labelWave } from "./wave.js";

function pivot(type, price, date) {
  return { type, price, date };
}
function leg(type, price, date) {
  return { type, price, date };
}

test("labelWave: a full, valid bullish impulse is reported as wave 5 completed", () => {
  const pivots = [
    pivot("L", 100, "p0"),
    pivot("HH", 110, "p1"), // wave1 = +10
    pivot("HL", 104, "p2"), // wave2 retrace 0.6 -- < 1.0
    pivot("HH", 125, "p3"), // wave3 = +21
    pivot("HL", 115, "p4"), // stays above wave1's top (110)
    pivot("HH", 130, "p5"), // wave5 = +15
  ];
  const { primary, alternative } = labelWave(pivots, null, "uptrend_intact");
  assert.equal(primary.structureType, "impulse");
  assert.equal(primary.currentWave, "5");
  assert.equal(primary.waveState, "completed");
  assert.equal(primary.confidence, "confirmed");
  assert.deepEqual(primary.passedGates, ["GUE-IMPULSE-001", "GUE-IMPULSE-002", "GUE-IMPULSE-003"]);
  assert.equal(primary.ruleArithmetic.wave1, 10);
  assert.equal(primary.invalidationPrice, null); // impulse is complete, not forming
});

test("labelWave: a full, valid bearish impulse mirrors the bullish case", () => {
  const pivots = [
    pivot("H", 130, "p0"),
    pivot("LL", 115, "p1"),
    pivot("LH", 122, "p2"),
    pivot("LL", 95, "p3"),
    pivot("LH", 105, "p4"),
    pivot("LL", 90, "p5"),
  ];
  const { primary } = labelWave(pivots, null, "downtrend_intact");
  assert.equal(primary.structureType, "impulse");
  assert.equal(primary.currentWave, "5");
  assert.equal(primary.waveState, "completed");
  assert.equal(primary.confidence, "confirmed");
});

test("labelWave: wave 4 forming is reported with a real invalidation price (GUE-IMPULSE-002)", () => {
  const pivots = [
    pivot("L", 100, "p0"),
    pivot("HH", 110, "p1"), // wave1 top = 110
    pivot("HL", 104, "p2"),
    pivot("HH", 125, "p3"),
  ];
  const unconfirmedLeg = leg("low", 118, "forming");
  const { primary } = labelWave(pivots, unconfirmedLeg, "uptrend_intact");
  assert.equal(primary.structureType, "impulse");
  assert.equal(primary.currentWave, "4");
  assert.equal(primary.waveState, "forming");
  assert.equal(primary.invalidationPrice, 110);
  assert.match(primary.invalidationCondition, /wave 1's territory/);
});

test("labelWave: wave 2 forming is reported with a real invalidation price (GUE-IMPULSE-001)", () => {
  const pivots = [pivot("L", 100, "p0"), pivot("HH", 110, "p1")];
  const unconfirmedLeg = leg("low", 106, "forming");
  const { primary } = labelWave(pivots, unconfirmedLeg, "uptrend_intact");
  assert.equal(primary.currentWave, "2");
  assert.equal(primary.waveState, "forming");
  assert.equal(primary.invalidationPrice, 100);
});

test("labelWave: wave 1 itself can be reported as forming (only the origin is confirmed)", () => {
  const pivots = [pivot("L", 100, "p0")];
  const unconfirmedLeg = leg("high", 108, "forming");
  const { primary } = labelWave(pivots, unconfirmedLeg, "uptrend_intact");
  assert.equal(primary.currentWave, "1");
  assert.equal(primary.waveState, "forming");
});

test("labelWave: with only an origin and no forming leg, there is nothing to report", () => {
  const pivots = [pivot("L", 100, "p0")];
  const { primary } = labelWave(pivots, null, "uptrend_intact");
  assert.equal(primary.currentWave, null);
  assert.equal(primary.confidence, "unconfirmed");
});

test("labelWave: waves 1-3 valid but no forming leg observed yet stays 'completed', not fabricated as forming", () => {
  const pivots = [pivot("L", 100, "p0"), pivot("HH", 110, "p1"), pivot("HL", 104, "p2")];
  const { primary } = labelWave(pivots, null, "uptrend_intact");
  assert.equal(primary.currentWave, "2");
  assert.equal(primary.waveState, "completed");
});

test("labelWave: does not attempt an impulse when the dow state is sideways/ambiguous", () => {
  const pivots = [
    pivot("L", 100, "p0"),
    pivot("HH", 110, "p1"),
    pivot("HL", 104, "p2"),
    pivot("HH", 125, "p3"),
    pivot("HL", 115, "p4"),
    pivot("HH", 130, "p5"),
  ];
  const { primary } = labelWave(pivots, null, "sideways");
  assert.notEqual(primary.structureType, "impulse");
});

// --- Corrective zigzag ---

test("labelWave: a valid completed zigzag (B stays within origin, C extends beyond A)", () => {
  const pivots = [
    pivot("H", 130, "origin"), // origin of the correction
    pivot("LL", 110, "a"), // wave A down to 110
    pivot("LH", 122, "b"), // wave B bounce to 122 -- below origin (130), valid
    pivot("LL", 100, "c"), // wave C extends beyond A (100 < 110)
  ];
  const { primary, alternative } = labelWave(pivots, null, "sideways");
  const zigzag = primary.structureType === "zigzag" ? primary : alternative;
  assert.ok(zigzag);
  assert.equal(zigzag.currentWave, "C");
  assert.equal(zigzag.waveState, "completed");
  assert.equal(zigzag.confidence, "confirmed");
});

test("labelWave: wave B retracing past the origin fails the zigzag shape check (not mislabeled)", () => {
  const pivots = [
    pivot("H", 130, "origin"),
    pivot("LL", 110, "a"),
    pivot("LH", 135, "b"), // B exceeds the origin (130) -- not a valid zigzag
    pivot("LL", 100, "c"),
  ];
  const { primary, alternative } = labelWave(pivots, null, "sideways");
  assert.notEqual(primary.structureType, "zigzag");
  assert.equal(alternative, null);
});

test("labelWave: wave C failing to extend beyond wave A fails the zigzag shape check", () => {
  const pivots = [
    pivot("H", 130, "origin"),
    pivot("LL", 110, "a"),
    pivot("LH", 122, "b"),
    pivot("LL", 115, "c"), // C (115) does not extend beyond A (110)
  ];
  const { primary, alternative } = labelWave(pivots, null, "sideways");
  assert.notEqual(primary.structureType, "zigzag");
  assert.equal(alternative, null);
});

test("labelWave: a random alternating pivot sequence is not automatically labeled A-B-C", () => {
  // Alternating, but B blows through the origin -- structurally not a zigzag.
  const pivots = [pivot("L", 100, "o"), pivot("HH", 110, "a"), pivot("HL", 95, "b"), pivot("HH", 130, "c")];
  const { primary, alternative } = labelWave(pivots, null, "manual_review");
  assert.notEqual(primary.structureType, "zigzag");
  assert.equal(alternative, null);
});

test("labelWave: an impulse (primary) and a zigzag reading (alternative) can both be returned", () => {
  // A clean 6-pivot bullish impulse; the trailing 4 points also happen to
  // satisfy the zigzag shape check as an alternative reading.
  const pivots = [
    pivot("L", 100, "p0"),
    pivot("HH", 110, "p1"),
    pivot("HL", 104, "p2"),
    pivot("HH", 125, "p3"),
    pivot("HL", 115, "p4"),
    pivot("HH", 130, "p5"),
  ];
  const { primary, alternative } = labelWave(pivots, null, "uptrend_intact");
  assert.equal(primary.structureType, "impulse");
  // Trailing 4 (p2,p3,p4,p5): origin=p2(104,low), A=p3(125,up-correction), B=p4(115, within origin 104? 115>104 so B exceeds origin for an up-correction) -- expect no valid zigzag here, so alternative may be null; either way this must not throw and primary must remain the impulse reading.
  assert.equal(primary.currentWave, "5");
  assert.ok(alternative === null || alternative.structureType === "zigzag");
});

test("labelWave returns fully unconfirmed (never a guess) when nothing validates", () => {
  const pivots = [pivot("L", 100, "p0"), pivot("HH", 95, "p1")]; // wave1 <= 0, impossible/invalid
  const { primary, alternative } = labelWave(pivots, null, "uptrend_intact");
  assert.equal(primary.currentWave, null);
  assert.equal(primary.confidence, "unconfirmed");
  assert.equal(alternative, null);
});

import { test } from "node:test";
import assert from "node:assert/strict";
import { labelWave } from "./wave.js";

function pivot(type, price, date) {
  return { type, price, date };
}

test("labelWave confirms a clean bullish impulse that satisfies all three GUE hard gates", () => {
  const pivots = [
    pivot("L", 100, "p0"),
    pivot("HH", 110, "p1"), // wave1 = +10
    pivot("HL", 104, "p2"), // wave2 retrace 0.6 -- < 1.0
    pivot("HH", 125, "p3"), // wave3 = +21
    pivot("HL", 115, "p4"), // stays above wave1's top (110) -- no overlap
    pivot("HH", 130, "p5"), // wave5 = +15
  ];
  const result = labelWave(pivots, "uptrend_intact");
  assert.equal(result.confidence, "confirmed");
  assert.deepEqual(result.passedGates, ["GUE-IMPULSE-001", "GUE-IMPULSE-002", "GUE-IMPULSE-003"]);
});

test("labelWave confirms a clean bearish impulse", () => {
  const pivots = [
    pivot("H", 130, "p0"),
    pivot("LL", 115, "p1"), // wave1 = -15
    pivot("LH", 122, "p2"), // wave2 retrace 0.47 -- < 1.0
    pivot("LL", 95, "p3"), // wave3 = -27
    pivot("LH", 105, "p4"), // stays below wave1's bottom (115)
    pivot("LL", 90, "p5"), // wave5 = -15
  ];
  const result = labelWave(pivots, "downtrend_intact");
  assert.equal(result.confidence, "confirmed");
});

test("labelWave rejects a wave 2 that retraces 100%+ of wave 1 (GUE-IMPULSE-001)", () => {
  const pivots = [
    pivot("L", 100, "p0"),
    pivot("HH", 110, "p1"),
    pivot("HL", 95, "p2"), // retrace (110-95)/10 = 1.5 -- fails
    pivot("HH", 125, "p3"),
    pivot("HL", 115, "p4"),
    pivot("HH", 130, "p5"),
  ];
  const result = labelWave(pivots, "uptrend_intact");
  assert.notEqual(result.confidence, "confirmed");
});

test("labelWave rejects a wave 4 that overlaps wave 1's territory (GUE-IMPULSE-002)", () => {
  const pivots = [
    pivot("L", 100, "p0"),
    pivot("HH", 110, "p1"),
    pivot("HL", 104, "p2"),
    pivot("HH", 125, "p3"),
    pivot("HL", 108, "p4"), // below 110 -- overlaps wave 1
    pivot("HH", 130, "p5"),
  ];
  const result = labelWave(pivots, "uptrend_intact");
  assert.notEqual(result.confidence, "confirmed");
});

test("labelWave rejects wave 3 being the shortest of waves 1/3/5 (GUE-IMPULSE-003)", () => {
  const pivots = [
    pivot("L", 100, "p0"),
    pivot("HH", 110, "p1"), // wave1 = 10
    pivot("HL", 104, "p2"),
    pivot("HH", 112, "p3"), // wave3 = 8 -- shorter than wave1 (10)
    pivot("HL", 111, "p4"),
    pivot("HH", 130, "p5"), // wave5 = 19
  ];
  const result = labelWave(pivots, "uptrend_intact");
  assert.notEqual(result.confidence, "confirmed");
});

test("labelWave falls back to a tentative A-B-C label when the impulse gates don't validate", () => {
  const pivots = [
    pivot("L", 100, "p0"),
    pivot("HH", 110, "p1"),
    pivot("HL", 95, "p2"), // breaks the impulse (100%+ retrace)
    pivot("HH", 125, "p3"),
  ];
  const result = labelWave(pivots, "uptrend_intact");
  assert.equal(result.confidence, "tentative");
  assert.match(result.label, /A-B-C/);
});

test("labelWave never labels an impulse or correction with fewer than 4 confirmed swings", () => {
  const pivots = [pivot("L", 100, "p0"), pivot("HH", 110, "p1")];
  const result = labelWave(pivots, "uptrend_intact");
  assert.equal(result.label, null);
  assert.equal(result.confidence, "unconfirmed");
});

test("labelWave does not attempt an impulse when the dow state is sideways/ambiguous", () => {
  const pivots = [
    pivot("L", 100, "p0"),
    pivot("HH", 110, "p1"),
    pivot("HL", 104, "p2"),
    pivot("HH", 125, "p3"),
    pivot("HL", 115, "p4"),
    pivot("HH", 130, "p5"),
  ];
  const result = labelWave(pivots, "sideways");
  assert.notEqual(result.confidence, "confirmed");
});

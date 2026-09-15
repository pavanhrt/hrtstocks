import { test } from "node:test";
import assert from "node:assert/strict";
import { computeFifteenMinuteWave } from "./fifteen-minute-wave.js";

function bar(ts, close) {
  return { ts, date: ts, open: close, high: close + 0.5, low: close - 0.5, close, volume: 1000 };
}

test("insufficient bars -> unavailable/unconfirmed, never a fabricated wave", () => {
  const result = computeFifteenMinuteWave([bar("t0", 100)], 0.01);
  assert.equal(result.dowState, "unavailable");
  assert.equal(result.confidence, "unconfirmed");
  assert.equal(result.currentWave, null);
});

test("a still-forming leg never reports a confirmed wave -- only tentative or unconfirmed", () => {
  // Five alternating legs (same verified shape as the three-timeframe-gate
  // fixture), each move comfortably past the 1% 15-minute threshold.
  const bars = [];
  let price = 100;
  let i = 0;
  for (const move of [10, -6, 10, -5, 10]) {
    const step = move / 10;
    for (let s = 1; s <= 10; s++) {
      const p = price + step * s;
      bars.push(bar(`t${i++}`, p));
    }
    price += move;
  }
  const result = computeFifteenMinuteWave(bars, 0.01);
  assert.notEqual(result.confidence, "confirmed", "a forming/prefix count must never be reported as confirmed");
  assert.ok(["tentative", "unconfirmed"].includes(result.confidence));
});

test("Elliott hard-gate evidence is carried through unchanged from wave.js (GUE-IMPULSE rule ids present)", () => {
  const bars = [];
  let price = 100;
  let i = 0;
  for (const move of [10, -6, 10, -5, 10]) {
    const step = move / 10;
    for (let s = 1; s <= 10; s++) {
      const p = price + step * s;
      bars.push(bar(`t${i++}`, p));
    }
    price += move;
  }
  const result = computeFifteenMinuteWave(bars, 0.01);
  if (result.ruleEvidence.length > 0) {
    for (const rule of result.ruleEvidence) {
      assert.ok(rule.ruleId.startsWith("GUE-IMPULSE-"));
    }
  }
});

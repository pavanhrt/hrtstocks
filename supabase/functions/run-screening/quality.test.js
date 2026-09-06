import { test } from "node:test";
import assert from "node:assert/strict";
import { validateBars } from "./quality.js";

const today = new Date().toISOString().slice(0, 10);

function goodBar(date, close = 100) {
  return { date, open: close - 1, high: close + 1, low: close - 2, close, volume: 1000 };
}

test("no bars is NO_DATA", () => {
  assert.equal(validateBars([]).result, "NO_DATA");
  assert.equal(validateBars(null).result, "NO_DATA");
});

test("clean recent bars pass", () => {
  const result = validateBars([goodBar("2026-09-01"), goodBar(today)]);
  assert.equal(result.result, "PASS");
  assert.deepEqual(result.issues, []);
});

test("high below low is flagged and quarantines that bar", () => {
  const bad = { date: today, open: 10, high: 5, low: 8, close: 6, volume: 100 };
  const result = validateBars([goodBar("2026-09-01"), bad]);
  assert.equal(result.result, "PARTIAL");
  assert.ok(result.issues.some((i) => i.includes("high below low")));
});

test("close outside high-low range is flagged", () => {
  const bad = { date: today, open: 10, high: 12, low: 9, close: 15, volume: 100 };
  const result = validateBars([bad]);
  assert.ok(result.issues.some((i) => i.includes("close outside high-low range")));
});

test("negative volume is flagged but does not alone invalidate the bar", () => {
  const bad = { date: today, open: 10, high: 12, low: 9, close: 11, volume: -5 };
  const result = validateBars([bad]);
  assert.equal(result.result, "PARTIAL");
  assert.ok(result.issues.some((i) => i.includes("volume")));
});

test("stale latest bar is flagged", () => {
  const result = validateBars([goodBar("2020-01-01")], { staleDays: 5 });
  assert.equal(result.result, "PARTIAL");
  assert.ok(result.issues.some((i) => i.includes("stale threshold")));
});

test("all-bad bars is INVALID, not PARTIAL", () => {
  const bad = { date: today, open: -1, high: -1, low: -1, close: -1, volume: 0 };
  const result = validateBars([bad]);
  assert.equal(result.result, "INVALID");
});

import { test } from "node:test";
import assert from "node:assert/strict";
import { computeAdjustedBars } from "./corporate-actions.js";

function bar(date, open, high, low, close, volume = 1000) {
  return { date, open, high, low, close, volume };
}

test("computeAdjustedBars leaves bars unchanged when there are no corporate actions", () => {
  const bars = [bar("2026-01-01", 100, 105, 95, 102), bar("2026-01-02", 102, 108, 100, 106)];
  const adjusted = computeAdjustedBars(bars, []);
  assert.deepEqual(adjusted, bars);
});

test("computeAdjustedBars scales every bar strictly before ex_date, and leaves bars on/after it untouched", () => {
  const bars = [
    bar("2026-01-01", 200, 210, 190, 205, 1000), // before the split
    bar("2026-01-15", 100, 105, 95, 102, 2000), // on/after the split (already post-split priced)
  ];
  // A 2-for-1 split: factor 0.5 halves pre-split prices, doubles pre-split volume.
  const actions = [{ action_type: "split", ex_date: "2026-01-10", factor: 0.5 }];
  const adjusted = computeAdjustedBars(bars, actions);

  assert.equal(adjusted[0].open, 100);
  assert.equal(adjusted[0].high, 105);
  assert.equal(adjusted[0].low, 95);
  assert.equal(adjusted[0].close, 102.5);
  assert.equal(adjusted[0].volume, 2000);

  // The second bar's date (2026-01-15) is not before ex_date (2026-01-10) -- untouched.
  assert.deepEqual(adjusted[1], bars[1]);
});

test("computeAdjustedBars compounds multiple qualifying actions multiplicatively", () => {
  const bars = [bar("2026-01-01", 400, 410, 390, 405, 1000)];
  const actions = [
    { action_type: "split", ex_date: "2026-02-01", factor: 0.5 }, // 2:1 split
    { action_type: "bonus", ex_date: "2026-03-01", factor: 0.5 }, // 1:1 bonus (another halving)
  ];
  const adjusted = computeAdjustedBars(bars, actions);
  // Both actions postdate the bar -> cumulative factor 0.5 * 0.5 = 0.25
  assert.equal(adjusted[0].close, 405 * 0.25);
  assert.equal(adjusted[0].volume, 1000 / 0.25);
});

test("computeAdjustedBars ignores a dividend action (disclosed scope limitation, not guessed)", () => {
  const bars = [bar("2026-01-01", 100, 105, 95, 102)];
  const actions = [{ action_type: "dividend", ex_date: "2026-06-01", factor: 0.98 }];
  const adjusted = computeAdjustedBars(bars, actions);
  assert.deepEqual(adjusted[0], bars[0]);
});

test("computeAdjustedBars ignores an action with a missing or non-positive factor rather than corrupting prices", () => {
  const bars = [bar("2026-01-01", 100, 105, 95, 102)];
  const actions = [
    { action_type: "split", ex_date: "2026-06-01", factor: null },
    { action_type: "split", ex_date: "2026-07-01", factor: 0 },
    { action_type: "split", ex_date: "2026-08-01", factor: -1 },
  ];
  const adjusted = computeAdjustedBars(bars, actions);
  assert.deepEqual(adjusted[0], bars[0]);
});

test("computeAdjustedBars does not mutate the input bars array", () => {
  const bars = [bar("2026-01-01", 100, 105, 95, 102)];
  const snapshot = JSON.parse(JSON.stringify(bars));
  computeAdjustedBars(bars, [{ action_type: "split", ex_date: "2026-06-01", factor: 0.5 }]);
  assert.deepEqual(bars, snapshot);
});

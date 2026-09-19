import { test } from "node:test";
import assert from "node:assert/strict";
import { seededShuffle } from "./shuffle.js";

test("seededShuffle returns a permutation of the input (same elements, same length)", () => {
  const items = Array.from({ length: 50 }, (_, i) => `S${i}`);
  const shuffled = seededShuffle(items, "eod_screening:2026-09-11");
  assert.equal(shuffled.length, items.length);
  assert.deepEqual([...shuffled].sort(), [...items].sort());
});

test("seededShuffle does not mutate its input", () => {
  const items = ["A", "B", "C", "D", "E"];
  const copy = [...items];
  seededShuffle(items, "seed");
  assert.deepEqual(items, copy);
});

test("seededShuffle is deterministic for the same seed", () => {
  const items = Array.from({ length: 30 }, (_, i) => `S${i}`);
  const a = seededShuffle(items, "eod_screening:2026-09-11");
  const b = seededShuffle(items, "eod_screening:2026-09-11");
  assert.deepEqual(a, b);
});

test("seededShuffle produces a different order for a different seed (day-to-day rotation)", () => {
  const items = Array.from({ length: 30 }, (_, i) => `S${i}`);
  const day1 = seededShuffle(items, "eod_screening:2026-09-11");
  const day2 = seededShuffle(items, "eod_screening:2026-09-12");
  assert.notDeepEqual(day1, day2);
});

test("seededShuffle actually reorders (not just an identity permutation) for a non-trivial list", () => {
  const items = Array.from({ length: 30 }, (_, i) => `S${i}`);
  const shuffled = seededShuffle(items, "eod_screening:2026-09-11");
  assert.notDeepEqual(shuffled, items);
});

test("seededShuffle handles empty and single-element lists", () => {
  assert.deepEqual(seededShuffle([], "seed"), []);
  assert.deepEqual(seededShuffle(["only"], "seed"), ["only"]);
});

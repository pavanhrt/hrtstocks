import { test } from "node:test";
import assert from "node:assert/strict";
import { reconcileCoverage } from "./reconcile.js";

test("reconciles when every stock has exactly one recognized tier", () => {
  const result = reconcileCoverage([
    { tier: "tier_a" },
    { tier: "tier_b" },
    { tier: "watch" },
    { tier: "manual_review" },
    { tier: "rejected" },
    { tier: "unavailable" },
  ]);
  assert.equal(result.unique_stock_count, 6);
  assert.equal(result.reconciled, true);
});

test("flags reconciliation failure when a tier value isn't one of the six recognized buckets", () => {
  const result = reconcileCoverage([{ tier: "tier_a" }, { tier: "some_unexpected_value" }]);
  assert.equal(result.unique_stock_count, 2);
  assert.equal(result.tier_a, 1);
  assert.equal(result.reconciled, false); // per shared-gates.yaml: publish_when_false must be false
});

test("empty universe reconciles trivially", () => {
  const result = reconcileCoverage([]);
  assert.equal(result.unique_stock_count, 0);
  assert.equal(result.reconciled, true);
});

import { test } from "node:test";
import assert from "node:assert/strict";
import { expectedAlignment, isAnalysisMember } from "./analysis-membership.ts";

test("bullish and bearish analysis use mutually exclusive Direction membership", () => {
  assert.equal(expectedAlignment("bullish"), "ALIGNED_BULLISH");
  assert.equal(expectedAlignment("bearish"), "ALIGNED_BEARISH");
  assert.notEqual(expectedAlignment("bullish"), expectedAlignment("bearish"));
});

test("analysis membership excludes indexes, mixed, opposite and unavailable instruments", () => {
  assert.equal(isAnalysisMember({ finalAlignment: "ALIGNED_BULLISH", isIndex: false }, "bullish"), true);
  assert.equal(isAnalysisMember({ finalAlignment: "ALIGNED_BULLISH", isIndex: true }, "bullish"), false);
  assert.equal(isAnalysisMember({ finalAlignment: "ALIGNED_BEARISH", isIndex: false }, "bullish"), false);
  assert.equal(isAnalysisMember({ finalAlignment: "MIXED", isIndex: false }, "bullish"), false);
  assert.equal(isAnalysisMember({ finalAlignment: "UNAVAILABLE", isIndex: false }, "bearish"), false);
});

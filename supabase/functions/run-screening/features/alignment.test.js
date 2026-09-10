import { test } from "node:test";
import assert from "node:assert/strict";
import { computeFinalAlignment } from "./alignment.js";

function tf(dowState) {
  return { dowState };
}

test("computeFinalAlignment returns ALIGNED_BULLISH when all three timeframes agree bullish and no opposing pattern exists", () => {
  const direction = { daily: tf("uptrend_intact"), weekly: tf("confirmed_reversal_bullish"), monthly: tf("uptrend_intact") };
  const result = computeFinalAlignment(direction, {});
  assert.equal(result.finalAlignment, "ALIGNED_BULLISH");
  assert.equal(result.smmAlignment, "bullish");
  assert.equal(result.opposingTriggeredPattern, null);
});

test("computeFinalAlignment returns ALIGNED_BEARISH when all three timeframes agree bearish", () => {
  const direction = { daily: tf("downtrend_intact"), weekly: tf("downtrend_intact"), monthly: tf("confirmed_reversal_bearish") };
  const result = computeFinalAlignment(direction, {});
  assert.equal(result.finalAlignment, "ALIGNED_BEARISH");
  assert.equal(result.smmAlignment, "bearish");
});

test("computeFinalAlignment returns SIDEWAYS when all three timeframes are sideways", () => {
  const direction = { daily: tf("sideways"), weekly: tf("sideways"), monthly: tf("sideways") };
  const result = computeFinalAlignment(direction, {});
  assert.equal(result.finalAlignment, "SIDEWAYS");
});

test("computeFinalAlignment returns MIXED when timeframes disagree", () => {
  const direction = { daily: tf("uptrend_intact"), weekly: tf("sideways"), monthly: tf("downtrend_intact") };
  const result = computeFinalAlignment(direction, {});
  assert.equal(result.finalAlignment, "MIXED");
  assert.equal(result.smmAlignment, "mixed");
  assert.match(result.reason, /daily=uptrend_intact/);
});

test("computeFinalAlignment returns UNAVAILABLE when no timeframe resolved", () => {
  const result = computeFinalAlignment({ daily: null, weekly: null, monthly: null }, {});
  assert.equal(result.finalAlignment, "UNAVAILABLE");
  assert.deepEqual(result.timeframesAvailable, []);
});

test("computeFinalAlignment returns MANUAL_REVIEW when only some timeframes resolved, never guessing confluence from a partial set", () => {
  const direction = { daily: tf("uptrend_intact"), weekly: tf("uptrend_intact"), monthly: null };
  const result = computeFinalAlignment(direction, {});
  assert.equal(result.finalAlignment, "MANUAL_REVIEW");
  assert.equal(result.smmAlignment, null);
  assert.deepEqual(result.timeframesAvailable, ["daily", "weekly"]);
});

test("computeFinalAlignment downgrades an aligned-bullish call to MANUAL_REVIEW when a TRIGGERED bearish pattern opposes it", () => {
  const direction = { daily: tf("uptrend_intact"), weekly: tf("uptrend_intact"), monthly: tf("uptrend_intact") };
  const patternsByTimeframe = {
    daily: [{ patternName: "Bearish Engulfing", direction: "bearish", state: "TRIGGERED" }],
  };
  const result = computeFinalAlignment(direction, patternsByTimeframe);
  assert.equal(result.finalAlignment, "MANUAL_REVIEW");
  assert.equal(result.smmAlignment, "bullish");
  assert.deepEqual(result.opposingTriggeredPattern, { timeframe: "daily", patternName: "Bearish Engulfing", direction: "bearish" });
});

test("computeFinalAlignment downgrades an aligned-bearish call to MANUAL_REVIEW when a TRIGGERED bullish pattern opposes it", () => {
  const direction = { daily: tf("downtrend_intact"), weekly: tf("downtrend_intact"), monthly: tf("downtrend_intact") };
  const patternsByTimeframe = {
    weekly: [{ patternName: "Double Bottom", direction: "bullish", state: "TRIGGERED" }],
  };
  const result = computeFinalAlignment(direction, patternsByTimeframe);
  assert.equal(result.finalAlignment, "MANUAL_REVIEW");
  assert.equal(result.opposingTriggeredPattern.patternName, "Double Bottom");
});

test("computeFinalAlignment stays ALIGNED_BULLISH when an opposing pattern is only OBSERVED, not TRIGGERED", () => {
  const direction = { daily: tf("uptrend_intact"), weekly: tf("uptrend_intact"), monthly: tf("uptrend_intact") };
  const patternsByTimeframe = {
    daily: [{ patternName: "Bearish Dark Cloud Cover", direction: "bearish", state: "OBSERVED" }],
  };
  const result = computeFinalAlignment(direction, patternsByTimeframe);
  assert.equal(result.finalAlignment, "ALIGNED_BULLISH");
});

test("computeFinalAlignment stays ALIGNED_BULLISH when the only TRIGGERED pattern agrees with (not opposes) the direction", () => {
  const direction = { daily: tf("uptrend_intact"), weekly: tf("uptrend_intact"), monthly: tf("uptrend_intact") };
  const patternsByTimeframe = {
    daily: [{ patternName: "Bullish Engulfing", direction: "bullish", state: "TRIGGERED" }],
  };
  const result = computeFinalAlignment(direction, patternsByTimeframe);
  assert.equal(result.finalAlignment, "ALIGNED_BULLISH");
  assert.equal(result.opposingTriggeredPattern, null);
});

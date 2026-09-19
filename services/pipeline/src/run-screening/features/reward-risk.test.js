import { test } from "node:test";
import assert from "node:assert/strict";
import { computeRewardRisk } from "./reward-risk.js";

test("computeRewardRisk: null route -> null", () => {
  assert.equal(computeRewardRisk({ route: null, bullish: true, currentPrice: 100, minimumRewardRiskStrict: 3.0 }), null);
});

test("computeRewardRisk: BUY-1-shaped route (stops.structural, targets array) -- picks the nearest target, computed honestly even when it doesn't clear the gate", () => {
  const route = {
    trigger: { close: 123 },
    stops: { tight: 108, structural: 100 },
    targets: [108 + 1.62 * 21, 108 + 2.62 * 21, 108 + 4.25 * 21], // 142.02, 163.02, 197.25
  };
  const result = computeRewardRisk({ route, bullish: true, currentPrice: 130, minimumRewardRiskStrict: 3.0 });
  assert.equal(result.entryPrice, 123);
  assert.equal(result.structuralStop, 100);
  assert.equal(result.conservativeTarget, 142.02); // nearest of the 3, per "take conservative targets"
  assert.equal(result.risk, 23);
  assert.ok(Math.abs(result.reward - 19.02) < 1e-9);
  assert.ok(result.rewardRiskRatio < 1); // this particular fixture does NOT clear 3 -- proves the gate isn't rigged to always pass
  assert.equal(result.passes, false);
});

test("computeRewardRisk: a route whose reward genuinely clears the strict >3 threshold passes", () => {
  const route = {
    trigger: { close: 100 },
    stops: { structural: 95 }, // risk = 5
    targets: [120], // reward = 20, ratio = 4
  };
  const result = computeRewardRisk({ route, bullish: true, currentPrice: 100, minimumRewardRiskStrict: 3.0 });
  assert.equal(result.rewardRiskRatio, 4);
  assert.equal(result.passes, true);
});

test("computeRewardRisk: exactly 3.0 fails the strict threshold -- matches the source's own '2.6 fails, do not round up' discipline applied at the boundary", () => {
  const route = { trigger: { close: 100 }, stops: { structural: 90 }, targets: [130] }; // risk=10, reward=30, ratio=3.0 exactly
  const result = computeRewardRisk({ route, bullish: true, currentPrice: 100, minimumRewardRiskStrict: 3.0 });
  assert.equal(result.rewardRiskRatio, 3.0);
  assert.equal(result.passes, false);
});

test("computeRewardRisk: a non-positive risk (invalid stop) never divides -- rewardRiskRatio is null, passes is false", () => {
  const route = { trigger: { close: 100 }, stops: { structural: 105 }, targets: [130] }; // stop ABOVE entry for a bullish route -- invalid
  const result = computeRewardRisk({ route, bullish: true, currentPrice: 100, minimumRewardRiskStrict: 3.0 });
  assert.equal(result.risk, -5);
  assert.equal(result.rewardRiskRatio, null);
  assert.equal(result.passes, false);
});

test("computeRewardRisk: a route with a stop but no computable target (e.g. BUY-4/SELL-4's shape) returns null -- never guesses a target", () => {
  const route = { trigger: null, stop: 100 }; // BUY-4/SELL-4's own single `stop` field, no `targets` at all
  const result = computeRewardRisk({ route, bullish: true, currentPrice: 130, minimumRewardRiskStrict: 3.0 });
  assert.equal(result, null);
});

test("computeRewardRisk: bearish route (stop above entry, target below) computes correctly", () => {
  const route = { trigger: { close: 100 }, stops: { structural: 110 }, targets: [70] }; // risk = 110-100=10, reward = 100-70=30
  const result = computeRewardRisk({ route, bullish: false, currentPrice: 100, minimumRewardRiskStrict: 3.0 });
  assert.equal(result.risk, 10);
  assert.equal(result.reward, 30);
  assert.equal(result.rewardRiskRatio, 3);
  assert.equal(result.passes, false); // exactly 3, strict > required
});

test("computeRewardRisk: SELL-1's targets shape (nearestDailySupport object, not an array) is read correctly", () => {
  const route = { trigger: { close: 145 }, stop: 183, targets: { nearestDailySupport: { price: 100 } } };
  const result = computeRewardRisk({ route, bullish: false, currentPrice: 145, minimumRewardRiskStrict: 3.0 });
  assert.equal(result.conservativeTarget, 100);
  assert.equal(result.structuralStop, 183);
});

test("computeRewardRisk: falls back to currentPrice as the entry when the route has no discrete trigger close (BUY-4/SELL-4's pattern-based entry)", () => {
  const route = { trigger: null, stop: 95, targets: [130] };
  const result = computeRewardRisk({ route, bullish: true, currentPrice: 105, minimumRewardRiskStrict: 3.0 });
  assert.equal(result.entryPrice, 105);
});

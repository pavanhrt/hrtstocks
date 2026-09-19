import { test } from "node:test";
import assert from "node:assert/strict";
import { classify, scoreComponents, rankWithinTiers } from "./rank.js";

test("classify: bad data quality is always unavailable/NO_DATA regardless of traces", () => {
  const { terminalState, tier } = classify([{ result: "PASS" }], [], "INVALID");
  assert.equal(terminalState, "NO_DATA");
  assert.equal(tier, "unavailable");
});

test("classify: a failed hard gate rejects even with otherwise-clean traces", () => {
  const { terminalState, tier } = classify([{ result: "PASS" }], ["SMM-RR-001"], "PASS");
  assert.equal(terminalState, "FAIL");
  assert.equal(tier, "rejected");
});

test("classify: all PASS with no manual review is Tier A", () => {
  const { terminalState, tier } = classify(
    [{ result: "PASS" }, { result: "PASS" }, { result: "NOT_APPLICABLE" }],
    [],
    "PASS"
  );
  assert.equal(terminalState, "PASS");
  assert.equal(tier, "tier_a");
});

test("classify: a CONFLICT forces manual_review even without a failed gate", () => {
  const { terminalState, tier } = classify([{ result: "PASS" }, { result: "CONFLICT" }], [], "PASS");
  assert.equal(terminalState, "MANUAL_REVIEW");
  assert.equal(tier, "manual_review");
});

test("classify: a WATCH rule with gates passed and no manual review is watch", () => {
  const { terminalState, tier } = classify([{ result: "PASS" }, { result: "WATCH" }], [], "PASS");
  assert.equal(terminalState, "WATCH");
  assert.equal(tier, "watch");
});

test("classify: hard gates pass but a required rule needs manual review", () => {
  const { terminalState, tier } = classify([{ result: "PASS" }, { result: "MANUAL_REVIEW" }], [], "PASS");
  assert.equal(terminalState, "MANUAL_REVIEW");
  assert.equal(tier, "manual_review");
});

test("scoreComponents: half of SMM rules passing yields half of the SMM weight", () => {
  const { componentScores, total } = scoreComponents({
    SMM: [{ result: "PASS" }, { result: "FAIL" }],
    PAPA: [],
    GUE: [],
  });
  assert.equal(componentScores.smm, 12.5); // 25 * 0.5
  assert.equal(total, 12.5);
});

test("scoreComponents: a framework with no decisive rules contributes zero, not an inflated average", () => {
  const { componentScores } = scoreComponents({ SMM: [{ result: "PASS" }], PAPA: [], GUE: [] });
  assert.equal(componentScores.papa, 0);
  assert.equal(componentScores.gue, 0);
});

test("rankWithinTiers: ranks only within the same direction+tier group", () => {
  const items = [
    { instrumentId: "A", direction: "bullish", tier: "tier_a", score: 80 },
    { instrumentId: "B", direction: "bullish", tier: "tier_a", score: 95 },
    { instrumentId: "C", direction: "bearish", tier: "tier_a", score: 99 },
  ];
  const ranked = rankWithinTiers(items);
  const a = ranked.find((r) => r.instrumentId === "A");
  const b = ranked.find((r) => r.instrumentId === "B");
  const c = ranked.find((r) => r.instrumentId === "C");
  assert.equal(b.rankWithinTier, 1);
  assert.equal(a.rankWithinTier, 2);
  // C is in a different direction group, so it's rank 1 in its own group
  // despite the highest raw score -- never compared against A/B.
  assert.equal(c.rankWithinTier, 1);
});

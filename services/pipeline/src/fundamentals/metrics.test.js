import { test } from "node:test";
import assert from "node:assert/strict";
import {
  deriveDebtToEquity, deriveInterestCoverage, deriveCurrentRatio,
  deriveRoe, deriveRoce, deriveOperatingMargin, deriveMarginStability,
  deriveRevenueCagr, derivePatCagr, deriveRecentGrowthConsistency, deriveGrowthQualityFlag,
  derivePromoterHoldingLevel, derivePromoterHoldingChange, derivePromoterPledge, deriveDilutionGovernanceFlags,
  deriveOcfToPat, deriveCashConversion, deriveFcfConsistency, deriveFutureGrowthEvidence, deriveAssetQualityTrend,
} from "./metrics.js";

test("negative equity: debt-to-equity is NOT_APPLICABLE, never a fabricated ratio against negative equity", () => {
  const r = deriveDebtToEquity({ total_debt: 500, total_equity: -100 });
  assert.equal(r.status, "NOT_APPLICABLE");
});

test("negative equity: ROE and ROCE are NOT_APPLICABLE against non-positive equity/capital-employed", () => {
  assert.equal(deriveRoe({ net_profit: 10, average_shareholder_equity: 0 }).status, "NOT_APPLICABLE");
  assert.equal(deriveRoe({ net_profit: 10, average_shareholder_equity: -50 }).status, "NOT_APPLICABLE");
  assert.equal(deriveRoce({ ebit: 10, capital_employed: -5 }).status, "NOT_APPLICABLE");
});

test("zero equity/debt/interest-expense edge cases are not silently treated as zero debt", () => {
  assert.equal(deriveDebtToEquity({ total_debt: null, total_equity: 100 }).status, "NO_DATA");
  assert.equal(deriveInterestCoverage({ ebit: 50, interest_expense: 0 }).status, "NOT_APPLICABLE");
});

test("loss-making company: PAT CAGR is NO_DATA when current PAT is non-positive, never a fabricated growth rate", () => {
  const r = derivePatCagr(5, -20, 100);
  assert.equal(r.status, "NO_DATA");
});

test("loss-making base year: PAT CAGR is NO_DATA when the base year was loss-making, never a wild/undefined percentage", () => {
  const r = derivePatCagr(5, 50, -10);
  assert.equal(r.status, "NO_DATA");
});

test("a genuinely profitable, growing company gets a real PAT CAGR value", () => {
  const r = derivePatCagr(5, 200, 100);
  assert.equal(r.status, "OK");
  assert.ok(Math.abs(r.value - (Math.pow(2, 1 / 5) - 1)) < 1e-9);
});

test("revenue CAGR against a non-positive base year is NO_DATA, not a fabricated multiple", () => {
  assert.equal(deriveRevenueCagr(3, 100, 0).status, "NO_DATA");
  assert.equal(deriveRevenueCagr(3, 100, -10).status, "NO_DATA");
});

test("insufficient history: fewer than 3 years of margin data is MANUAL_REVIEW, not a computed (meaningless) stdev", () => {
  assert.equal(deriveMarginStability([0.1, 0.12]).status, "MANUAL_REVIEW");
  assert.equal(deriveMarginStability(null).status, "MANUAL_REVIEW");
});

test("insufficient history: 3+ years of margin data is scored", () => {
  const r = deriveMarginStability([0.1, 0.11, 0.09, 0.1, 0.1]);
  assert.equal(r.status, "OK");
  assert.ok(r.value > 0.8);
});

test("insufficient history: fewer than 4 quarters is MANUAL_REVIEW for growth consistency", () => {
  assert.equal(deriveRecentGrowthConsistency([{ yoyRevenueGrowth: 0.1, isExceptionalItem: false }]).status, "MANUAL_REVIEW");
});

test("extraordinary/one-time income: an exceptional-item quarter is excluded from growth consistency's numerator and denominator alike", () => {
  const quarters = [
    { yoyRevenueGrowth: 0.05, isExceptionalItem: false },
    { yoyRevenueGrowth: 0.08, isExceptionalItem: false },
    { yoyRevenueGrowth: 5.0, isExceptionalItem: true }, // one-time gain -- must not count as a "good" quarter
    { yoyRevenueGrowth: -0.02, isExceptionalItem: false },
  ];
  const r = deriveRecentGrowthConsistency(quarters);
  assert.equal(r.status, "OK");
  assert.equal(r.value, 2 / 3); // 2 positive out of 3 ordinary quarters, exceptional quarter excluded entirely
});

test("extraordinary/one-time income: growth_quality_flag scores 0 when an exceptional item inflated the latest PAT, 1 otherwise", () => {
  assert.equal(deriveGrowthQualityFlag(true).value, 0);
  assert.equal(deriveGrowthQualityFlag(false).value, 1);
  assert.equal(deriveGrowthQualityFlag(null).status, "MANUAL_REVIEW");
});

test("professionally managed / no-promoter company: all three promoter sub-metrics are NOT_APPLICABLE, never scored as poor quality", () => {
  assert.equal(derivePromoterHoldingLevel("professionally_managed", null).status, "NOT_APPLICABLE");
  assert.equal(derivePromoterHoldingChange("professionally_managed", null, null).status, "NOT_APPLICABLE");
  assert.equal(derivePromoterPledge("professionally_managed", null, null).status, "NOT_APPLICABLE");
});

test("promoter holding change: a real increase/decrease is scored from actual history, not guessed", () => {
  const r = derivePromoterHoldingChange("promoter", 0.55, 0.50);
  assert.equal(r.status, "OK");
  assert.ok(Math.abs(r.value - 0.05) < 1e-9);
});

test("promoter holding change: missing 4-quarters-ago data is NO_DATA, not treated as zero change", () => {
  assert.equal(derivePromoterHoldingChange("promoter", 0.55, null).status, "NO_DATA");
});

test("promoter pledge: a real pledge ratio is computed; zero pledge scores as a real, defined zero (not NO_DATA)", () => {
  const r = derivePromoterPledge("promoter", 0, 1000);
  assert.equal(r.status, "OK");
  assert.equal(r.value, 0);
});

test("promoter pledge: undisclosed pledge is NO_DATA, never assumed zero", () => {
  assert.equal(derivePromoterPledge("promoter", null, 1000).status, "NO_DATA");
});

test("dilution/governance flags: undisclosed flags are MANUAL_REVIEW, not assumed clean", () => {
  assert.equal(deriveDilutionGovernanceFlags(null).status, "MANUAL_REVIEW");
  assert.equal(deriveDilutionGovernanceFlags({ materialDilution: false, qualifiedAudit: null, regulatoryDefault: false }).status, "MANUAL_REVIEW");
});

test("dilution/governance flags: every red flag disclosed and true reduces the score correctly, floored at 0", () => {
  assert.equal(deriveDilutionGovernanceFlags({ materialDilution: true, qualifiedAudit: true, regulatoryDefault: true }).value, 1);
  assert.equal(deriveDilutionGovernanceFlags({ materialDilution: false, qualifiedAudit: false, regulatoryDefault: false }).value, 4);
});

test("cash flow: OCF/PAT is NO_DATA for a loss-making company, never a nonsensical negative ratio dressed up as quality", () => {
  assert.equal(deriveOcfToPat(50, -20).status, "NO_DATA");
});

test("cash flow: a DISAGREEMENT provenance is MANUAL_REVIEW, not NO_DATA -- conflicting evidence is a different, more actionable state than no evidence at all", () => {
  const ocfEvidence = { provenance: "DISAGREEMENT", topLevel: 178703, fullStatement: 120000 };
  const result = deriveOcfToPat(null, 80787, ocfEvidence);
  assert.equal(result.status, "MANUAL_REVIEW");
  // both raw values must be preserved for the evidence table -- never
  // silently dropped once a value has been resolved to null.
  assert.equal(result.raw.topLevel, 178703);
  assert.equal(result.raw.fullStatement, 120000);
});

test("cash flow: a DISAGREEMENT provenance still yields NO_DATA (not MANUAL_REVIEW) when PAT itself is undisclosed or non-positive -- the harder blocker wins", () => {
  const ocfEvidence = { provenance: "DISAGREEMENT", topLevel: 178703, fullStatement: 120000 };
  assert.equal(deriveOcfToPat(null, null, ocfEvidence).status, "NO_DATA");
  assert.equal(deriveOcfToPat(null, -20, ocfEvidence).status, "NO_DATA");
});

test("cash flow: agreement or a fallback provenance (not DISAGREEMENT) scores normally off the resolved value", () => {
  assert.equal(deriveOcfToPat(178703, 80787, { provenance: "TOP_LEVEL", topLevel: 178703, fullStatement: 178703 }).status, "OK");
  assert.equal(deriveOcfToPat(120000, 80787, { provenance: "FULL_STATEMENT_FALLBACK", topLevel: null, fullStatement: 120000 }).status, "OK");
});

test("cash conversion: a DISAGREEMENT provenance is MANUAL_REVIEW once ebitda is actually disclosed", () => {
  const ocfEvidence = { provenance: "DISAGREEMENT", topLevel: 178703, fullStatement: 120000 };
  const result = deriveCashConversion(null, 200000, ocfEvidence);
  assert.equal(result.status, "MANUAL_REVIEW");
  assert.equal(result.raw.topLevel, 178703);
});

test("cash conversion: undisclosed ebitda is still NO_DATA regardless of OCF disagreement -- ebitda is the harder blocker", () => {
  const ocfEvidence = { provenance: "DISAGREEMENT", topLevel: 178703, fullStatement: 120000 };
  assert.equal(deriveCashConversion(null, null, ocfEvidence).status, "NO_DATA");
});

test("cash flow: FCF consistency needs at least 3 fiscal years", () => {
  assert.equal(deriveFcfConsistency([100, -50]).status, "NO_DATA");
  const r = deriveFcfConsistency([100, -50, 40, 60, 80]);
  assert.equal(r.status, "OK");
  assert.equal(r.value, 4 / 5);
});

test("future growth: never derived from stock-price momentum, never invented -- absent evidence is NO_DATA", () => {
  assert.equal(deriveFutureGrowthEvidence(null, { disclosed_order_book_growth: 4, disclosed_capacity_expansion_or_capex: 3, disclosed_regulatory_approval_or_guidance: 3 }).status, "NO_DATA");
});

test("future growth: partially normalized evidence (one category undisclosed) is MANUAL_REVIEW, not scored as if absent", () => {
  const r = deriveFutureGrowthEvidence({ disclosedOrderBookGrowth: true, disclosedCapacityExpansionOrCapex: null, disclosedRegulatoryApprovalOrGuidance: false }, { disclosed_order_book_growth: 4, disclosed_capacity_expansion_or_capex: 3, disclosed_regulatory_approval_or_guidance: 3 });
  assert.equal(r.status, "MANUAL_REVIEW");
});

test("future growth: fully disclosed evidence sums the per-category weights", () => {
  const weights = { disclosed_order_book_growth: 4, disclosed_capacity_expansion_or_capex: 3, disclosed_regulatory_approval_or_guidance: 3 };
  const r = deriveFutureGrowthEvidence({ disclosedOrderBookGrowth: true, disclosedCapacityExpansionOrCapex: true, disclosedRegulatoryApprovalOrGuidance: false }, weights);
  assert.equal(r.value, 7);
});

test("bank/NBFC asset-quality trend: needs 2 comparable periods, positive value means improving (GNPA falling)", () => {
  assert.equal(deriveAssetQualityTrend(null, 0.02).status, "NO_DATA");
  const improving = deriveAssetQualityTrend(0.03, 0.02);
  assert.equal(improving.status, "OK");
  assert.ok(improving.value > 0);
});

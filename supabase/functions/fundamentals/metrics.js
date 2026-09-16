// Derives per-sub-metric {status, value, raw} pairs from a filing's raw,
// as-reported financial fields, implementing the exact applicability rules
// documented in fundamentals/fundamental-score.yaml's sub_metric `note`
// fields. This is the ONLY layer that decides "is this metric applicable /
// available / ambiguous" -- scoring.js's scoreSubMetric never guesses this
// itself. Every function here is pure and touches only fundamental fields
// (never price/volume/technical indicators).

import { SUB_METRIC_STATUS } from "./scoring.js";

const { OK, NOT_APPLICABLE, NO_DATA, MANUAL_REVIEW } = SUB_METRIC_STATUS;

function ok(value, raw) {
  return { status: OK, value, raw };
}
function na(raw, explanation) {
  return { status: NOT_APPLICABLE, value: null, raw, explanation };
}
function noData(raw, explanation) {
  return { status: NO_DATA, value: null, raw, explanation };
}
function manualReview(raw, explanation) {
  return { status: MANUAL_REVIEW, value: null, raw, explanation };
}

// ---------------------------------------------------------------------------
// Non-financial: balance sheet
// ---------------------------------------------------------------------------

export function deriveDebtToEquity(f) {
  if (f.total_equity == null) return noData(f, "total_equity not disclosed");
  if (f.total_equity <= 0) return na(f, "negative or zero equity -- debt-to-equity is not a meaningful leverage measure");
  if (f.total_debt == null) return noData(f, "total_debt not disclosed");
  return ok(f.total_debt / f.total_equity, f);
}

export function deriveInterestCoverage(f) {
  if (f.interest_expense == null) return noData(f, "interest_expense not disclosed");
  if (f.interest_expense <= 0) return na(f, "no interest expense -- no debt-service burden to cover");
  if (f.ebit == null) return noData(f, "ebit not disclosed");
  return ok(f.ebit / f.interest_expense, f);
}

export function deriveNetDebtToEbitda(f) {
  if (f.ebitda == null) return noData(f, "ebitda not disclosed");
  if (f.ebitda <= 0) return noData(f, "ebitda is non-positive -- ratio not meaningful");
  if (f.net_debt == null) return noData(f, "net_debt not disclosed");
  return ok(f.net_debt / f.ebitda, f);
}

export function deriveCurrentRatio(f) {
  if (f.current_liabilities == null || f.current_assets == null) return noData(f, "current assets/liabilities not disclosed");
  if (f.current_liabilities <= 0) return manualReview(f, "current_liabilities is non-positive -- ratio undefined");
  return ok(f.current_assets / f.current_liabilities, f);
}

// ---------------------------------------------------------------------------
// Non-financial: profitability
// ---------------------------------------------------------------------------

export function deriveRoe(f) {
  if (f.average_shareholder_equity == null) return noData(f, "average_shareholder_equity not disclosed");
  if (f.average_shareholder_equity <= 0) return na(f, "negative or zero average equity -- ROE is not meaningful");
  if (f.net_profit == null) return noData(f, "net_profit not disclosed");
  return ok(f.net_profit / f.average_shareholder_equity, f);
}

export function deriveRoce(f) {
  if (f.capital_employed == null) return noData(f, "capital_employed not disclosed");
  if (f.capital_employed <= 0) return na(f, "negative or zero capital employed -- ROCE is not meaningful");
  if (f.ebit == null) return noData(f, "ebit not disclosed");
  return ok(f.ebit / f.capital_employed, f);
}

export function deriveOperatingMargin(f) {
  if (f.revenue == null) return noData(f, "revenue not disclosed");
  if (f.revenue <= 0) return noData(f, "revenue is non-positive -- margin not meaningful");
  if (f.operating_profit == null) return noData(f, "operating_profit not disclosed");
  return ok(f.operating_profit / f.revenue, f);
}

/** @param {number[]|null} operatingMarginLast5y */
export function deriveMarginStability(operatingMarginLast5y) {
  if (!Array.isArray(operatingMarginLast5y) || operatingMarginLast5y.length < 3) {
    return manualReview(operatingMarginLast5y, "fewer than 3 years of operating-margin history -- stability cannot be assessed");
  }
  const mean = operatingMarginLast5y.reduce((a, b) => a + b, 0) / operatingMarginLast5y.length;
  if (mean === 0) return manualReview(operatingMarginLast5y, "mean operating margin is zero -- stability ratio undefined");
  const variance = operatingMarginLast5y.reduce((sum, m) => sum + (m - mean) ** 2, 0) / operatingMarginLast5y.length;
  const stdev = Math.sqrt(variance);
  return ok(1 - stdev / Math.abs(mean), operatingMarginLast5y);
}

// ---------------------------------------------------------------------------
// Non-financial: growth
// ---------------------------------------------------------------------------

/** Shared CAGR deriver for revenue (never NOT_APPLICABLE for a non-negative base, unlike PAT). */
export function deriveRevenueCagr(years, current, base) {
  if (current == null || base == null) return noData({ current, base }, `revenue for t or t-${years} not disclosed`);
  if (base <= 0) return noData({ current, base }, `revenue ${years} years ago was non-positive -- CAGR not meaningful`);
  return ok((current / base) ** (1 / years) - 1, { current, base });
}

/**
 * PAT/EPS CAGR -- unlike revenue, a currently loss-making company (pat_t <= 0)
 * or a loss-making base year makes the CAGR not just unavailable but
 * actively misleading if computed (a swing from -10 to +5 has no valid CAGR;
 * neither does a swing from 5 to -10). Both report NO_DATA, never a
 * fabricated large percentage or a silently negative-but-plausible number.
 */
export function derivePatCagr(years, current, base) {
  if (current == null || base == null) return noData({ current, base }, `PAT for t or t-${years} not disclosed`);
  if (current <= 0) return noData({ current, base }, "currently loss-making -- PAT CAGR is not a meaningful growth figure");
  if (base <= 0) return noData({ current, base }, `PAT ${years} years ago was non-positive -- CAGR against a loss-making base is not meaningful`);
  return ok((current / base) ** (1 / years) - 1, { current, base });
}

/**
 * @param {Array<{yoyRevenueGrowth: number, isExceptionalItem: boolean}>|null} lastEightQuarters
 */
export function deriveRecentGrowthConsistency(lastEightQuarters) {
  if (!Array.isArray(lastEightQuarters) || lastEightQuarters.length < 4) {
    return manualReview(lastEightQuarters, "fewer than 4 quarters of history -- consistency cannot be assessed");
  }
  // Exceptional-item quarters are excluded from both numerator and
  // denominator -- a one-time gain must never count as ordinary recurring
  // growth, but it also shouldn't be counted as a "bad" quarter either; it
  // simply isn't evidence of operating growth either way.
  const ordinary = lastEightQuarters.filter((q) => !q.isExceptionalItem);
  if (ordinary.length === 0) return manualReview(lastEightQuarters, "every available quarter contained a material exceptional item");
  const positive = ordinary.filter((q) => q.yoyRevenueGrowth > 0).length;
  return ok(positive / ordinary.length, lastEightQuarters);
}

/** @param {boolean|null} hasExceptionalItemInflatingLatestPat */
export function deriveGrowthQualityFlag(hasExceptionalItemInflatingLatestPat) {
  if (hasExceptionalItemInflatingLatestPat == null) return manualReview(null, "snapshot does not disclose whether an exceptional item exists");
  return ok(hasExceptionalItemInflatingLatestPat ? 0 : 1, { hasExceptionalItemInflatingLatestPat });
}

// ---------------------------------------------------------------------------
// Promoter / governance (shared across sector models)
// ---------------------------------------------------------------------------

/** @param {"promoter"|"professionally_managed"|null} ownershipStructure */
function isNoPromoter(ownershipStructure) {
  return ownershipStructure === "professionally_managed";
}

export function derivePromoterHoldingLevel(ownershipStructure, latestPromoterHolding) {
  if (isNoPromoter(ownershipStructure)) return na({ ownershipStructure }, "professionally managed / no-promoter company -- not penalized for having no promoter");
  if (latestPromoterHolding == null) return noData({ ownershipStructure }, "promoter holding not disclosed");
  return ok(latestPromoterHolding, { ownershipStructure, latestPromoterHolding });
}

export function derivePromoterHoldingChange(ownershipStructure, latest, fourQuartersAgo) {
  if (isNoPromoter(ownershipStructure)) return na({ ownershipStructure }, "professionally managed / no-promoter company");
  if (latest == null || fourQuartersAgo == null) return noData({ latest, fourQuartersAgo }, "fewer than 4 quarters of promoter-holding history");
  return ok(latest - fourQuartersAgo, { latest, fourQuartersAgo });
}

export function derivePromoterPledge(ownershipStructure, pledgedShares, totalPromoterShares) {
  if (isNoPromoter(ownershipStructure)) return na({ ownershipStructure }, "professionally managed / no-promoter company");
  if (totalPromoterShares == null || totalPromoterShares <= 0) return noData({ pledgedShares, totalPromoterShares }, "promoter shareholding not disclosed");
  if (pledgedShares == null) return noData({ pledgedShares, totalPromoterShares }, "pledge disclosure not available");
  return ok(pledgedShares / totalPromoterShares, { pledgedShares, totalPromoterShares });
}

/** @param {{materialDilution: boolean, qualifiedAudit: boolean, regulatoryDefault: boolean}|null} flags */
export function deriveDilutionGovernanceFlags(flags) {
  if (flags == null || flags.materialDilution == null || flags.qualifiedAudit == null || flags.regulatoryDefault == null) {
    return manualReview(flags, "one or more governance red-flag disclosures are unavailable");
  }
  const redFlagCount = [flags.materialDilution, flags.qualifiedAudit, flags.regulatoryDefault].filter(Boolean).length;
  return ok(Math.max(0, 4 - redFlagCount), flags);
}

// ---------------------------------------------------------------------------
// Non-financial: cash flow
// ---------------------------------------------------------------------------

/**
 * @param {number|null} operatingCashFlow -- upstox-normalize.js's resolved
 *   operating_cash_flow (null when undisclosed OR when the two independent
 *   Upstox sources materially disagree -- see `ocfEvidence`).
 * @param {number|null} pat
 * @param {{provenance: string, topLevel: number|null, fullStatement: number|null}|null} [ocfEvidence]
 *   -- when `provenance === "DISAGREEMENT"`, this sub-metric is MANUAL_REVIEW
 *   (conflicting evidence exists, which is a materially different, more
 *   actionable state than NO_DATA/"no evidence exists at all") and both raw
 *   values are carried in the result for the evidence table -- never
 *   silently resolved to a picked scalar.
 */
export function deriveOcfToPat(operatingCashFlow, pat, ocfEvidence = null) {
  if (pat == null) return noData({ operatingCashFlow, pat }, "PAT not disclosed");
  if (pat <= 0) return noData({ operatingCashFlow, pat }, "loss-making -- OCF/PAT is not meaningful");
  if (ocfEvidence?.provenance === "DISAGREEMENT") {
    return manualReview({ operatingCashFlow, pat, ...ocfEvidence }, "operating cash flow top-level and full-statement figures materially disagree -- resolve manually before scoring");
  }
  if (operatingCashFlow == null) return noData({ operatingCashFlow, pat }, "operating cash flow not disclosed");
  return ok(operatingCashFlow / pat, { operatingCashFlow, pat });
}

/** @param {number[]|null} freeCashFlowLast5Years */
export function deriveFcfConsistency(freeCashFlowLast5Years) {
  if (!Array.isArray(freeCashFlowLast5Years) || freeCashFlowLast5Years.length < 3) {
    return noData(freeCashFlowLast5Years, "fewer than 3 fiscal years of free-cash-flow history");
  }
  const positive = freeCashFlowLast5Years.filter((v) => v > 0).length;
  return ok(positive / freeCashFlowLast5Years.length, freeCashFlowLast5Years);
}

/** @param {{provenance: string, topLevel: number|null, fullStatement: number|null}|null} [ocfEvidence] -- see deriveOcfToPat's own doc. */
export function deriveCashConversion(operatingCashFlow, ebitda, ocfEvidence = null) {
  if (ebitda == null) return noData({ operatingCashFlow, ebitda }, "ebitda not disclosed");
  if (ebitda <= 0) return noData({ operatingCashFlow, ebitda }, "ebitda is non-positive");
  if (ocfEvidence?.provenance === "DISAGREEMENT") {
    return manualReview({ operatingCashFlow, ebitda, ...ocfEvidence }, "operating cash flow top-level and full-statement figures materially disagree -- resolve manually before scoring");
  }
  if (operatingCashFlow == null) return noData({ operatingCashFlow, ebitda }, "operating cash flow not disclosed");
  return ok(operatingCashFlow / ebitda, { operatingCashFlow, ebitda });
}

// ---------------------------------------------------------------------------
// Future growth (shared) -- ONLY from dated, attributable, pre-cutoff evidence.
// ---------------------------------------------------------------------------

/**
 * @param {{disclosedOrderBookGrowth: boolean, disclosedCapacityExpansionOrCapex: boolean, disclosedRegulatoryApprovalOrGuidance: boolean}|null} categories
 *   -- each boolean must come from a dated filing/presentation whose
 *   publication_timestamp is on or before the run cutoff (enforced upstream
 *   by filings.js's selectApplicableFiling, not here). `null` (the whole
 *   object, or an individual category) means "not disclosed", not "false".
 */
export function deriveFutureGrowthEvidence(categories, weights) {
  if (categories == null) return noData(null, "no forward-looking evidence disclosed in an eligible pre-cutoff filing");
  const keys = ["disclosedOrderBookGrowth", "disclosedCapacityExpansionOrCapex", "disclosedRegulatoryApprovalOrGuidance"];
  if (keys.some((k) => categories[k] == null)) {
    return manualReview(categories, "forward-looking evidence exists but could not be fully normalized into the defined categories");
  }
  const points =
    (categories.disclosedOrderBookGrowth ? weights.disclosed_order_book_growth : 0) +
    (categories.disclosedCapacityExpansionOrCapex ? weights.disclosed_capacity_expansion_or_capex : 0) +
    (categories.disclosedRegulatoryApprovalOrGuidance ? weights.disclosed_regulatory_approval_or_guidance : 0);
  return { status: OK, value: points, raw: categories, isPoints: true };
}

// ---------------------------------------------------------------------------
// Bank / NBFC
// ---------------------------------------------------------------------------

export function deriveRatioField(raw, key, note) {
  const value = raw?.[key];
  if (value == null) return noData(raw, note ?? `${key} not disclosed`);
  return ok(value, raw);
}

export function deriveAssetQualityTrend(gnpaPrevious, gnpaLatest) {
  if (gnpaPrevious == null || gnpaLatest == null) return noData({ gnpaPrevious, gnpaLatest }, "fewer than 2 comparable periods of GNPA disclosed");
  return ok(gnpaPrevious - gnpaLatest, { gnpaPrevious, gnpaLatest });
}

export function deriveGrowthCagr(years, current, base, label) {
  if (current == null || base == null) return noData({ current, base }, `${label} history not disclosed`);
  if (base <= 0) return noData({ current, base }, `${label} base value is non-positive`);
  return ok((current / base) ** (1 / years) - 1, { current, base });
}

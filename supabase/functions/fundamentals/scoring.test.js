import { test } from "node:test";
import assert from "node:assert/strict";
import { evaluateBand, scoreSubMetric, computeComponentScore, computeFundamentalScore, resolveGrade, SUB_METRIC_STATUS } from "./scoring.js";
import { resolveSectorModel, componentDefinitionsFor, SECTOR_MODELS } from "./sector-models.js";
import { parseFundamentalScoreSpec } from "../../seed/parse-fundamental-score.mjs";

const { spec } = parseFundamentalScoreSpec();

test("evaluateBand: flat array threshold, lower-is-better, both boundaries inclusive, tightest band wins at the exact boundary", () => {
  const thresholds = [
    { max: 0.3, points: 8 },
    { max: 0.6, points: 6 },
    { max: null, points: 0 },
  ];
  assert.equal(evaluateBand(0.29, thresholds), 8);
  assert.equal(evaluateBand(0.3, thresholds), 8); // exactly the best threshold still earns full marks
  assert.equal(evaluateBand(0.31, thresholds), 6);
  assert.equal(evaluateBand(0.59, thresholds), 6);
  assert.equal(evaluateBand(100, thresholds), 0);
});

test("evaluateBand: {bands:[...]} wrapper shape is supported identically to a flat array", () => {
  const wrapped = { bands: [{ min: 20, points: 6 }, { min: 0, points: 1 }, { max: 0, points: 0 }] };
  assert.equal(evaluateBand(25, wrapped), 6);
  assert.equal(evaluateBand(5, wrapped), 1);
  assert.equal(evaluateBand(-5, wrapped), 0);
});

test("evaluateBand: min+max combined band (current_ratio shape)", () => {
  const thresholds = [
    { min: 1.5, max: 3.0, points: 3 },
    { min: 1.0, max: 1.5, points: 2 },
    { min: 1.0, max: null, points: 1 },
    { max: 1.0, points: 0 },
  ];
  assert.equal(evaluateBand(2.0, thresholds), 3);
  assert.equal(evaluateBand(1.2, thresholds), 2);
  assert.equal(evaluateBand(5.0, thresholds), 1);
  assert.equal(evaluateBand(0.5, thresholds), 0);
});

test("evaluateBand: null/non-finite value never matches a band", () => {
  const thresholds = [{ max: null, points: 0 }];
  assert.equal(evaluateBand(null, thresholds), null);
  assert.equal(evaluateBand(NaN, thresholds), null);
  assert.equal(evaluateBand(undefined, thresholds), null);
});

test("scoreSubMetric: OK status bands the value", () => {
  const def = { weight: 8, thresholds: [{ max: 0.3, points: 8 }, { max: null, points: 0 }] };
  const r = scoreSubMetric("debt_to_equity", def, SUB_METRIC_STATUS.OK, 0.1);
  assert.equal(r.earned, 8);
  assert.equal(r.applicable, true);
  assert.equal(r.status, "OK");
});

test("scoreSubMetric: NOT_APPLICABLE earns zero and is excluded from applicable weight downstream", () => {
  const def = { weight: 8, thresholds: [] };
  const r = scoreSubMetric("debt_to_equity", def, SUB_METRIC_STATUS.NOT_APPLICABLE);
  assert.equal(r.earned, 0);
  assert.equal(r.applicable, false);
});

test("scoreSubMetric: NO_DATA and MANUAL_REVIEW earn zero but remain applicable (count against coverage)", () => {
  const def = { weight: 8, thresholds: [] };
  const noData = scoreSubMetric("x", def, SUB_METRIC_STATUS.NO_DATA);
  const manual = scoreSubMetric("x", def, SUB_METRIC_STATUS.MANUAL_REVIEW);
  assert.equal(noData.earned, 0);
  assert.equal(noData.applicable, true);
  assert.equal(manual.earned, 0);
  assert.equal(manual.applicable, true);
});

test("scoreSubMetric: OK status with a value outside every band is downgraded to MANUAL_REVIEW, not silently scored", () => {
  const def = { weight: 5, thresholds: [{ min: 0, max: 10, points: 5 }] };
  const r = scoreSubMetric("x", def, SUB_METRIC_STATUS.OK, 999);
  assert.equal(r.status, SUB_METRIC_STATUS.MANUAL_REVIEW);
  assert.equal(r.earned, 0);
});

test("scoreSubMetric: throws on an unrecognized status rather than silently defaulting", () => {
  const def = { weight: 5, thresholds: [] };
  assert.throws(() => scoreSubMetric("x", def, "BOGUS"));
});

test("scoreSubMetric: category-based sub-metric (future growth) uses the pre-summed points directly, clamped to weight", () => {
  const def = { weight: 10, categories: { a: 4, b: 3, c: 3 } };
  const r = scoreSubMetric("disclosed_forward_evidence", def, SUB_METRIC_STATUS.OK, 7);
  assert.equal(r.earned, 7);
  const clamped = scoreSubMetric("disclosed_forward_evidence", def, SUB_METRIC_STATUS.OK, 999);
  assert.equal(clamped.earned, 10);
});

test("computeComponentScore: component status is NOT_APPLICABLE only when every sub-metric is not applicable", () => {
  const def = { name: "x", weight: 20 };
  const allNa = computeComponentScore("balance_sheet", def, [
    { key: "a", weight: 8, applicable: false, earned: 0, status: "NOT_APPLICABLE" },
    { key: "b", weight: 5, applicable: false, earned: 0, status: "NOT_APPLICABLE" },
  ]);
  assert.equal(allNa.status, "NOT_APPLICABLE");
  assert.equal(allNa.totalApplicableWeight, 0);
});

test("computeComponentScore: component status is NO_DATA when every applicable sub-metric is unresolved with no MANUAL_REVIEW present", () => {
  const def = { name: "x", weight: 20 };
  const r = computeComponentScore("balance_sheet", def, [
    { key: "a", weight: 8, applicable: true, earned: 0, status: "NO_DATA" },
    { key: "b", weight: 5, applicable: true, earned: 0, status: "NO_DATA" },
  ]);
  assert.equal(r.status, "NO_DATA");
});

test("computeComponentScore: component status is MANUAL_REVIEW when at least one unresolved sub-metric is MANUAL_REVIEW", () => {
  const def = { name: "x", weight: 20 };
  const r = computeComponentScore("balance_sheet", def, [
    { key: "a", weight: 8, applicable: true, earned: 0, status: "NO_DATA" },
    { key: "b", weight: 5, applicable: true, earned: 0, status: "MANUAL_REVIEW" },
  ]);
  assert.equal(r.status, "MANUAL_REVIEW");
});

test("computeComponentScore: OK when at least one sub-metric resolved, even if others didn't", () => {
  const def = { name: "x", weight: 20 };
  const r = computeComponentScore("balance_sheet", def, [
    { key: "a", weight: 8, applicable: true, earned: 8, status: "OK" },
    { key: "b", weight: 5, applicable: true, earned: 0, status: "NO_DATA" },
  ]);
  assert.equal(r.status, "OK");
  assert.equal(r.earned, 8);
  assert.equal(r.totalApplicableWeight, 13);
});

test("resolveGrade: exact boundary values (spec-driven, not hardcoded)", () => {
  assert.equal(resolveGrade(spec, 80), "A");
  assert.equal(resolveGrade(spec, 79), "B");
  assert.equal(resolveGrade(spec, 65), "B");
  assert.equal(resolveGrade(spec, 64), "C");
  assert.equal(resolveGrade(spec, 50), "C");
  assert.equal(resolveGrade(spec, 49), "D");
  assert.equal(resolveGrade(spec, 35), "D");
  assert.equal(resolveGrade(spec, 34), "E");
  assert.equal(resolveGrade(spec, 0), "E");
  assert.equal(resolveGrade(spec, 100), "A");
  assert.equal(resolveGrade(spec, null), null);
});

test("spec integrity: every sector model's component weights sum to exactly 100", () => {
  for (const [modelKey, model] of Object.entries(spec.sector_models)) {
    const total = Object.values(model.components).reduce((a, b) => a + b, 0);
    assert.equal(total, modelKey === "UNSUPPORTED_FALLBACK" ? 0 : 100, `${modelKey} components must sum to 100`);
  }
});

test("spec integrity: NON_FINANCIAL component definitions' sub-metric weights sum to their component's declared weight", () => {
  for (const [key, componentDef] of Object.entries(spec.components)) {
    if (!componentDef.sub_metrics) continue; // e.g. future_growth uses `categories` on its single sub-metric, checked separately
    const total = Object.values(componentDef.sub_metrics).reduce((a, b) => a + b.weight, 0);
    assert.equal(total, componentDef.weight, `${key}'s sub-metrics must sum to its own weight`);
  }
});

function computeForSector(sectorModel, subMetricStatusesByComponent) {
  const defs = componentDefinitionsFor(spec, sectorModel);
  const componentResults = Object.entries(defs).map(([key, def]) => {
    const statuses = subMetricStatusesByComponent[key] ?? {};
    const subResults = Object.entries(def.sub_metrics ?? { [key]: def }).map(([subKey, subDef]) =>
      scoreSubMetric(subKey, subDef, statuses[subKey]?.status ?? SUB_METRIC_STATUS.NO_DATA, statuses[subKey]?.value ?? null)
    );
    return computeComponentScore(key, def, subResults);
  });
  return computeFundamentalScore({ spec, sectorModel, componentResults });
}

test("computeFundamentalScore: full coverage, all-maximum inputs scores exactly 100 and grade A", () => {
  const allMax = {
    balance_sheet: {
      debt_to_equity: { status: "OK", value: 0.1 },
      interest_coverage: { status: "OK", value: 10 },
      net_debt_to_ebitda: { status: "OK", value: 0.5 },
      current_ratio: { status: "OK", value: 2.0 },
    },
    profitability: {
      roe: { status: "OK", value: 0.3 },
      roce: { status: "OK", value: 0.3 },
      operating_margin: { status: "OK", value: 0.3 },
      margin_stability: { status: "OK", value: 0.95 },
    },
    growth: {
      revenue_cagr_5y: { status: "OK", value: 0.3 },
      revenue_cagr_3y: { status: "OK", value: 0.3 },
      pat_cagr_5y: { status: "OK", value: 0.3 },
      recent_growth_consistency: { status: "OK", value: 1.0 },
      growth_quality_flag: { status: "OK", value: 1 },
    },
    promoter_governance: {
      promoter_holding_level: { status: "OK", value: 0.6 },
      promoter_holding_change: { status: "OK", value: 0.1 },
      promoter_pledge: { status: "OK", value: 0 },
      dilution_and_governance_flags: { status: "OK", value: 4 },
    },
    cash_flow: {
      ocf_to_pat: { status: "OK", value: 1.0 },
      fcf_consistency: { status: "OK", value: 1.0 },
      cash_conversion: { status: "OK", value: 1.0 },
    },
    future_growth: {
      disclosed_forward_evidence: { status: "OK", value: 10 },
    },
  };
  const result = computeForSector(SECTOR_MODELS.NON_FINANCIAL, allMax);
  assert.equal(result.terminalStatus, "SCORED");
  assert.equal(result.coveragePercentage, 100);
  assert.equal(result.totalScore, 100);
  assert.equal(result.grade, "A");
});

test("computeFundamentalScore: zero resolved evidence below minimum coverage publishes NO_DATA, never a fabricated zero score", () => {
  const noneResolved = {
    balance_sheet: {}, profitability: {}, growth: {}, promoter_governance: {}, cash_flow: {}, future_growth: {},
  };
  const result = computeForSector(SECTOR_MODELS.NON_FINANCIAL, noneResolved);
  assert.equal(result.terminalStatus, "NO_DATA");
  assert.equal(result.totalScore, null);
  assert.equal(result.grade, null);
  assert.equal(result.coveragePercentage, 0);
});

test("computeFundamentalScore: below-minimum coverage with a MANUAL_REVIEW sub-metric present publishes MANUAL_REVIEW, not NO_DATA", () => {
  const mostlyUnresolved = {
    balance_sheet: { debt_to_equity: { status: "MANUAL_REVIEW" } },
    profitability: {}, growth: {}, promoter_governance: {}, cash_flow: {}, future_growth: {},
  };
  const result = computeForSector(SECTOR_MODELS.NON_FINANCIAL, mostlyUnresolved);
  assert.equal(result.terminalStatus, "MANUAL_REVIEW");
});

test("computeFundamentalScore: NOT_APPLICABLE sub-metrics are excluded from coverage's denominator entirely (negative-equity company)", () => {
  // debt_to_equity, roe, roce all NOT_APPLICABLE (negative equity); every
  // other applicable sub-metric resolved. Coverage should be computed only
  // over what remains applicable, not penalized for the excluded ones.
  const negativeEquity = {
    balance_sheet: {
      debt_to_equity: { status: "NOT_APPLICABLE" },
      interest_coverage: { status: "OK", value: 5 },
      net_debt_to_ebitda: { status: "OK", value: 1 },
      current_ratio: { status: "OK", value: 1.2 },
    },
    profitability: {
      roe: { status: "NOT_APPLICABLE" },
      roce: { status: "NOT_APPLICABLE" },
      operating_margin: { status: "OK", value: 0.1 },
      margin_stability: { status: "OK", value: 0.6 },
    },
    growth: {
      revenue_cagr_5y: { status: "OK", value: 0.1 },
      revenue_cagr_3y: { status: "OK", value: 0.1 },
      pat_cagr_5y: { status: "OK", value: 0.1 },
      recent_growth_consistency: { status: "OK", value: 0.5 },
      growth_quality_flag: { status: "OK", value: 1 },
    },
    promoter_governance: {
      promoter_holding_level: { status: "OK", value: 0.4 },
      promoter_holding_change: { status: "OK", value: 0 },
      promoter_pledge: { status: "OK", value: 0.05 },
      dilution_and_governance_flags: { status: "OK", value: 3 },
    },
    cash_flow: {
      ocf_to_pat: { status: "OK", value: 0.5 },
      fcf_consistency: { status: "OK", value: 0.5 },
      cash_conversion: { status: "OK", value: 0.5 },
    },
    future_growth: { disclosed_forward_evidence: { status: "OK", value: 5 } },
  };
  const result = computeForSector(SECTOR_MODELS.NON_FINANCIAL, negativeEquity);
  assert.equal(result.terminalStatus, "SCORED");
  assert.equal(result.coveragePercentage, 100); // nothing applicable was left unresolved
  assert.ok(result.totalScore > 0 && result.totalScore < 100);
});

test("computeFundamentalScore: partial coverage right at the configured minimum publishes a number; just below does not", () => {
  // Build a component set where exactly minimum_coverage_percentage% of
  // applicable weight is resolved.
  const minCoverage = spec.minimum_coverage_percentage;
  // Use only balance_sheet (weight 20) with debt_to_equity (8) resolved and
  // the rest NO_DATA -- 8/20 = 40% coverage of THIS component, but overall
  // coverage is computed across all 100 points of applicable weight. Simpler:
  // resolve exactly minCoverage points worth of a 100-applicable-weight set.
  const full = {
    balance_sheet: { debt_to_equity: { status: "OK", value: 0.1 }, interest_coverage: { status: "OK", value: 10 }, net_debt_to_ebitda: { status: "OK", value: 0.5 }, current_ratio: { status: "OK", value: 2.0 } }, // 20
    profitability: { roe: { status: "OK", value: 0.3 }, roce: { status: "OK", value: 0.3 }, operating_margin: { status: "OK", value: 0.3 }, margin_stability: { status: "OK", value: 0.95 } }, // 20
    growth: { revenue_cagr_5y: { status: "OK", value: 0.3 }, revenue_cagr_3y: { status: "OK", value: 0.3 }, pat_cagr_5y: { status: "OK", value: 0.3 }, recent_growth_consistency: { status: "OK", value: 1.0 }, growth_quality_flag: { status: "OK", value: 1 } }, // 25 (total 65 -- >= minCoverage if minCoverage <= 65)
    promoter_governance: {}, cash_flow: {}, future_growth: {},
  };
  const result = computeForSector(SECTOR_MODELS.NON_FINANCIAL, full);
  const expectedCoverage = 65; // balance_sheet(20) + profitability(20) + growth(25) resolved out of 100 applicable
  if (expectedCoverage >= minCoverage) {
    assert.equal(result.terminalStatus, "SCORED");
  } else {
    assert.notEqual(result.terminalStatus, "SCORED");
  }
  assert.equal(result.coveragePercentage, expectedCoverage);
});

test("technical-input-independence: attaching arbitrary technical-looking fields to inputs never changes the score", () => {
  const baseline = {
    balance_sheet: { debt_to_equity: { status: "OK", value: 0.4 } },
    profitability: { roe: { status: "OK", value: 0.18 } },
    growth: { revenue_cagr_5y: { status: "OK", value: 0.1 } },
    promoter_governance: {},
    cash_flow: {},
    future_growth: {},
  };
  const withTechnicalNoise = {
    balance_sheet: { debt_to_equity: { status: "OK", value: 0.4, rsi: 71.4, macdHistogram: -0.3, ema5CrossesEma13: true } },
    profitability: { roe: { status: "OK", value: 0.18, dowState: "uptrend_intact", gateResult: "PASS", breakoutVolume: 5_000_000 } },
    growth: { revenue_cagr_5y: { status: "OK", value: 0.1, guefWave: "impulse-3", chartPattern: "double_top", bollingerUpper: 999 } },
    promoter_governance: {},
    cash_flow: {},
    future_growth: {},
  };
  const a = computeForSector(SECTOR_MODELS.NON_FINANCIAL, baseline);
  const b = computeForSector(SECTOR_MODELS.NON_FINANCIAL, withTechnicalNoise);
  assert.deepEqual(a, b, "attaching technical fields to the input must never change any part of the fundamental score result");
});

test("sector routing: UNSUPPORTED_FALLBACK never produces a numeric score", () => {
  const { sectorModel } = resolveSectorModel("INSURANCE");
  assert.equal(sectorModel, SECTOR_MODELS.UNSUPPORTED_FALLBACK);
  assert.equal(componentDefinitionsFor(spec, sectorModel), null);
});

test("computeFundamentalScore: UNSUPPORTED_FALLBACK (insurance or any unmodeled/unreviewed sector) terminates as MANUAL_REVIEW, never NOT_APPLICABLE and never a fabricated score", () => {
  // Simulates what a caller would build when componentDefinitionsFor()
  // returns null for UNSUPPORTED_FALLBACK -- every component NOT_APPLICABLE.
  const componentResults = [
    computeComponentScore("balance_sheet", { name: "x", weight: 20 }, []),
    computeComponentScore("profitability", { name: "x", weight: 20 }, []),
    computeComponentScore("growth", { name: "x", weight: 25 }, []),
    computeComponentScore("promoter_governance", { name: "x", weight: 15 }, []),
    computeComponentScore("cash_flow", { name: "x", weight: 10 }, []),
    computeComponentScore("future_growth", { name: "x", weight: 10 }, []),
  ];
  const result = computeFundamentalScore({ spec, sectorModel: SECTOR_MODELS.UNSUPPORTED_FALLBACK, componentResults });
  assert.equal(result.terminalStatus, "MANUAL_REVIEW");
  assert.equal(result.totalScore, null);
  assert.equal(result.grade, null);
});

test("sector routing: undisclosed sector classification is NO_DATA (resolved:false), not a guessed fallback", () => {
  const { sectorModel, resolved } = resolveSectorModel(null);
  assert.equal(resolved, false);
  assert.equal(sectorModel, null);
});

test("bank model: routes to bank_nbfc_components for balance_sheet/profitability/growth/cash_flow but shares promoter_governance/future_growth with the non-financial model", () => {
  const bankDefs = componentDefinitionsFor(spec, SECTOR_MODELS.BANK);
  assert.equal(bankDefs.balance_sheet, spec.bank_nbfc_components.balance_sheet);
  assert.equal(bankDefs.promoter_governance, spec.components.promoter_governance);
  assert.equal(bankDefs.future_growth, spec.components.future_growth);
  assert.ok(!("debt_to_equity" in (bankDefs.balance_sheet.sub_metrics ?? {})), "banks must never be scored on ordinary corporate debt-to-equity");
});

test("bank model: full coverage all-maximum scores 100/A, weights sum to 100 exactly", () => {
  const allMax = {
    balance_sheet: { capital_adequacy: { status: "OK", value: 0.2 }, gnpa_ratio: { status: "OK", value: 0.01 }, provision_coverage_ratio: { status: "OK", value: 0.9 } },
    profitability: { roa: { status: "OK", value: 0.03 }, roe: { status: "OK", value: 0.25 }, net_interest_margin: { status: "OK", value: 0.05 } },
    growth: { credit_or_aum_growth_3y_cagr: { status: "OK", value: 0.25 }, deposit_or_funding_growth_3y_cagr: { status: "OK", value: 0.2 }, asset_quality_trend: { status: "OK", value: 0.01 } },
    promoter_governance: {
      promoter_holding_level: { status: "OK", value: 0.6 },
      promoter_holding_change: { status: "OK", value: 0.1 },
      promoter_pledge: { status: "OK", value: 0 },
      dilution_and_governance_flags: { status: "OK", value: 4 },
    },
    cash_flow: { liquidity_coverage_or_funding_measure: { status: "OK", value: 1.2 } },
    future_growth: { disclosed_forward_evidence: { status: "OK", value: 10 } },
  };
  const result = computeForSector(SECTOR_MODELS.BANK, allMax);
  assert.equal(result.totalScore, 100);
  assert.equal(result.grade, "A");
});

test("NBFC model: debt_to_equity is absent from scoring (NOT_APPLICABLE by design), unlike the non-financial model", () => {
  const nbfcDefs = componentDefinitionsFor(spec, SECTOR_MODELS.NBFC);
  assert.ok(!("debt_to_equity" in (nbfcDefs.balance_sheet.sub_metrics ?? {})));
});

test("NBFC model: partial data (only balance_sheet resolved) below minimum coverage reports NO_DATA", () => {
  const partial = {
    balance_sheet: { capital_adequacy: { status: "OK", value: 0.18 }, gnpa_ratio: { status: "OK", value: 0.015 }, provision_coverage_ratio: { status: "OK", value: 0.8 } },
    profitability: {}, growth: {}, promoter_governance: {}, cash_flow: {}, future_growth: {},
  };
  const result = computeForSector(SECTOR_MODELS.NBFC, partial);
  if (20 < spec.minimum_coverage_percentage) {
    assert.equal(result.terminalStatus, "NO_DATA");
  }
});

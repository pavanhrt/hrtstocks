// Pure fundamental-score computation (fundamentals/fundamental-score.yaml,
// PROJECT_DEFAULT -- see that file's decision_record).
//
// INDEPENDENCE GUARANTEE: every function in this module takes only
// fundamental evidence as input -- a sub-metric's resolved {status, value}
// pair, sourced from a fundamental filing snapshot. No function here reads,
// destructures, or has any parameter for price, volume, EMA, RSI, MACD,
// Bollinger Bands, DMI/ADX, Dow structure, chart pattern, candlestick
// pattern, breakout, or GUE wave evidence -- there is no code path by which a
// technical value could influence the output, not merely a convention that
// it doesn't. scoring.test.js's technical-input-independence test proves
// this empirically by attaching arbitrary technical-looking properties to
// every input object and asserting the score is byte-for-byte identical.
//
// This module is deliberately kept OUTSIDE services/pipeline/src/run-screening
// and services/pipeline/src/analyze-buy-setup -- it has zero import
// relationship with either, in either direction.

export const SUB_METRIC_STATUS = Object.freeze({
  OK: "OK",
  NOT_APPLICABLE: "NOT_APPLICABLE",
  NO_DATA: "NO_DATA",
  MANUAL_REVIEW: "MANUAL_REVIEW",
});

const UNRESOLVED_STATUSES = new Set([SUB_METRIC_STATUS.NO_DATA, SUB_METRIC_STATUS.MANUAL_REVIEW]);

/**
 * Normalizes a sub-metric's `thresholds` field (the YAML uses both a flat
 * array and a `{bands: [...]}` wrapper interchangeably) into a flat band
 * array, then returns the points for the FIRST band (in listed order) whose
 * [min, max] range contains `value` -- both bounds inclusive. Bands must be
 * listed tightest/best-first so a boundary value (e.g. exactly the best
 * threshold) matches the most favorable band rather than falling through to
 * a worse one. `null` on either bound means unbounded on that side.
 */
export function evaluateBand(value, thresholdsSpec) {
  if (value == null || !Number.isFinite(value)) return null;
  const bands = Array.isArray(thresholdsSpec) ? thresholdsSpec : thresholdsSpec?.bands;
  if (!Array.isArray(bands)) return null;
  for (const band of bands) {
    const minOk = band.min == null || value >= band.min;
    const maxOk = band.max == null || value <= band.max;
    if (minOk && maxOk) return band.points;
  }
  return null;
}

/**
 * Scores one sub-metric. `status` and `value` come from the CALLER's own
 * point-in-time normalization of a real filing (see filings.js/normalize.js)
 * -- this function performs no applicability judgment itself (e.g. "is
 * equity negative") because that judgment depends on which raw fields a
 * given sub-metric's formula needs, which varies per metric; each metric's
 * own applicability rule is documented in fundamental-score.yaml's `note`.
 *
 * @param {string} key
 * @param {object} def -- the sub_metric definition from the spec (weight, thresholds).
 * @param {"OK"|"NOT_APPLICABLE"|"NO_DATA"|"MANUAL_REVIEW"} status
 * @param {number|null} value -- required when status is OK, ignored otherwise.
 * @param {object} [raw] -- the raw inputs behind `value`, kept for the evidence table.
 * @param {string} [explanation]
 */
export function scoreSubMetric(key, def, status, value = null, raw = null, explanation = "") {
  if (!Object.values(SUB_METRIC_STATUS).includes(status)) {
    throw new Error(`scoreSubMetric: unknown status "${status}" for sub-metric "${key}"`);
  }
  const weight = def.weight;
  if (status === SUB_METRIC_STATUS.NOT_APPLICABLE) {
    return { key, weight, applicable: false, earned: 0, status, value: null, raw, explanation: explanation || "not applicable to this instrument" };
  }
  if (status !== SUB_METRIC_STATUS.OK) {
    // NO_DATA / MANUAL_REVIEW -- applicable but unresolved: counts toward
    // total_applicable_weight (reduces coverage) but earns zero points.
    return { key, weight, applicable: true, earned: 0, status, value: null, raw, explanation: explanation || (status === SUB_METRIC_STATUS.NO_DATA ? "no evidence available" : "requires manual review") };
  }
  // A category-based sub-metric (e.g. future_growth's disclosed_forward_evidence)
  // has no threshold bands -- `value` is already the earned point total,
  // computed by summing per-category weights (see metrics.js's
  // deriveFutureGrowthEvidence). Clamp defensively so a bad category sum can
  // never exceed the sub-metric's own weight.
  if (def.categories || def.direct_points) {
    const clamped = Math.max(0, Math.min(value, weight));
    return { key, weight, applicable: true, earned: clamped, status: SUB_METRIC_STATUS.OK, value, raw, explanation: explanation || `${clamped}/${weight}` };
  }

  const points = evaluateBand(value, def.thresholds);
  if (points == null) {
    // A well-formed threshold table always covers the full real line; a
    // miss here means the value fell outside every band (e.g. NaN slipped
    // through, or the spec has a gap) -- surfaced honestly as MANUAL_REVIEW
    // rather than silently scored as 0/full marks.
    return { key, weight, applicable: true, earned: 0, status: SUB_METRIC_STATUS.MANUAL_REVIEW, value, raw, explanation: `value ${value} did not match any defined threshold band` };
  }
  return { key, weight, applicable: true, earned: points, status: SUB_METRIC_STATUS.OK, value, raw, explanation: explanation || `${value} scored ${points}/${weight}` };
}

/** Aggregates a component's sub-metric results into one component-level record. */
export function computeComponentScore(componentKey, componentDef, subMetricResults) {
  const applicable = subMetricResults.filter((r) => r.applicable);
  const totalApplicableWeight = applicable.reduce((sum, r) => sum + r.weight, 0);
  const earned = applicable.reduce((sum, r) => sum + r.earned, 0);
  const unresolvedCount = applicable.filter((r) => UNRESOLVED_STATUSES.has(r.status)).length;

  let status;
  if (applicable.length === 0) status = SUB_METRIC_STATUS.NOT_APPLICABLE;
  else if (unresolvedCount === applicable.length) status = applicable.some((r) => r.status === SUB_METRIC_STATUS.MANUAL_REVIEW) ? SUB_METRIC_STATUS.MANUAL_REVIEW : SUB_METRIC_STATUS.NO_DATA;
  else status = SUB_METRIC_STATUS.OK;

  return {
    key: componentKey,
    name: componentDef.name,
    weight: componentDef.weight,
    totalApplicableWeight,
    earned,
    status,
    subMetrics: subMetricResults,
  };
}

/** @param {object} spec @param {number} score */
export function resolveGrade(spec, score) {
  if (score == null) return null;
  const band = spec.grades.find((g) => score >= g.min && score <= g.max);
  return band ? band.grade : null;
}

/**
 * Aggregates every component into the final published (or NO_DATA/
 * MANUAL_REVIEW) fundamental score. `componentResults` is the array
 * returned by computeComponentScore for every component defined for this
 * sector model.
 *
 * coverage_percentage = available_applicable_weight / total_applicable_weight * 100
 * -- exactly the formula requested: NOT_APPLICABLE sub-metrics are excluded
 * from both numerator and denominator (the metric doesn't exist for this
 * instrument, so it can't count against coverage); NO_DATA/MANUAL_REVIEW
 * sub-metrics count in the denominator only (they were applicable, just
 * unresolved), depressing coverage.
 */
export function computeFundamentalScore({ spec, sectorModel, componentResults }) {
  const allSubMetrics = componentResults.flatMap((c) => c.subMetrics);
  const applicable = allSubMetrics.filter((r) => r.applicable);
  const totalApplicableWeight = applicable.reduce((sum, r) => sum + r.weight, 0);
  const availableApplicableWeight = applicable.filter((r) => r.status === SUB_METRIC_STATUS.OK).length
    ? applicable.filter((r) => r.status === SUB_METRIC_STATUS.OK).reduce((sum, r) => sum + r.weight, 0)
    : 0;
  const earned = applicable.reduce((sum, r) => sum + r.earned, 0);

  const coveragePercentage = totalApplicableWeight > 0 ? (availableApplicableWeight / totalApplicableWeight) * 100 : 0;
  const hasAnyManualReview = applicable.some((r) => r.status === SUB_METRIC_STATUS.MANUAL_REVIEW);
  const meetsMinimumCoverage = coveragePercentage >= spec.minimum_coverage_percentage;

  if (totalApplicableWeight === 0) {
    // Every component was NOT_APPLICABLE -- an UNSUPPORTED_FALLBACK sector
    // (a known-but-unmodeled regulated business like insurance, or a
    // genuinely new/unreviewed sector string -- see
    // upstox-sector-taxonomy.js). REVISED 2026-09-16: this is MANUAL_REVIEW,
    // not NOT_APPLICABLE -- "we have no rubric for this sector" always
    // deserves a human look, unlike a per-instrument NOT_APPLICABLE fact
    // (e.g. "this company has no promoter") that a reviewer can already be
    // certain about.
    return { sectorModel, totalScore: null, grade: null, coveragePercentage: 0, terminalStatus: SUB_METRIC_STATUS.MANUAL_REVIEW, componentResults };
  }
  if (!meetsMinimumCoverage) {
    return {
      sectorModel,
      totalScore: null,
      grade: null,
      coveragePercentage: Math.round(coveragePercentage * 10) / 10,
      terminalStatus: hasAnyManualReview ? SUB_METRIC_STATUS.MANUAL_REVIEW : SUB_METRIC_STATUS.NO_DATA,
      componentResults,
    };
  }

  const totalScore = Math.round((earned / totalApplicableWeight) * 100);
  return {
    sectorModel,
    totalScore,
    grade: resolveGrade(spec, totalScore),
    coveragePercentage: Math.round(coveragePercentage * 10) / 10,
    terminalStatus: "SCORED",
    componentResults,
  };
}

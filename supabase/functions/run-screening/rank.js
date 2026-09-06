// Tiering and ranking per strategies/shared-gates.yaml. Ranking only ever
// runs after hard gates are known (see index.js), and never compares across
// direction or tier (shared-gates.yaml: within_same_direction_and_tier_only).

const TERMINAL_STATE = {
  PASS: "PASS",
  WATCH: "WATCH",
  MANUAL_REVIEW: "MANUAL_REVIEW",
  FAIL: "FAIL",
  NO_DATA: "NO_DATA",
};

/**
 * Determines one instrument's tier and terminal state from its evaluated
 * rule traces and data quality, per shared-gates.yaml's tier conditions.
 *
 * @param {{ result: string }[]} traces
 * @param {string[]} failedGates
 * @param {"PASS"|"PARTIAL"|"STALE"|"INVALID"|"NO_DATA"} dataQuality
 * @returns {{ terminalState: string, tier: string }}
 */
export function classify(traces, failedGates, dataQuality) {
  if (dataQuality !== "PASS") {
    return { terminalState: TERMINAL_STATE.NO_DATA, tier: "unavailable" };
  }

  if (failedGates.length > 0) {
    return { terminalState: TERMINAL_STATE.FAIL, tier: "rejected" };
  }

  const hasManualReview = traces.some((t) => t.result === "MANUAL_REVIEW");
  const hasConflict = traces.some((t) => t.result === "CONFLICT");
  if (hasConflict) {
    return { terminalState: TERMINAL_STATE.MANUAL_REVIEW, tier: "manual_review" };
  }

  const allPassOrNotApplicable = traces.every((t) => t.result === "PASS" || t.result === "NOT_APPLICABLE");
  if (allPassOrNotApplicable && !hasManualReview) {
    return { terminalState: TERMINAL_STATE.PASS, tier: "tier_a" };
  }

  if (!hasManualReview && traces.some((t) => t.result === "WATCH")) {
    // Passed every hard gate (checked above) but a soft/confirming rule is
    // still WATCH -- directional context exists, confirmation is pending.
    return { terminalState: TERMINAL_STATE.WATCH, tier: "watch" };
  }

  if (hasManualReview) {
    return { terminalState: TERMINAL_STATE.MANUAL_REVIEW, tier: "manual_review" };
  }

  // Hard gates passed, no MANUAL_REVIEW/WATCH, but some non-gate rule FAILed --
  // still qualifies as a lower-confidence match rather than a full pass.
  return { terminalState: TERMINAL_STATE.WATCH, tier: "tier_b" };
}

/**
 * Scores one instrument's component contributions (0-100 total per
 * shared-gates.yaml `ranking.components`). Each component is the fraction of
 * that framework's non-gate rules that PASSed, scaled to its point weight.
 * Frameworks with no applicable rules contribute 0 rather than skewing the
 * average toward frameworks that happened to run.
 */
const COMPONENT_WEIGHTS = {
  SMM: 25,
  PAPA: 30,
  GUE: 15,
  RISK_REWARD: 10,
  DATA_LIQUIDITY: 5,
  VOLUME_MOMENTUM: 15,
};

export function scoreComponents(tracesByFramework) {
  const componentScores = {};
  let total = 0;

  for (const [framework, weight] of [
    ["SMM", COMPONENT_WEIGHTS.SMM],
    ["PAPA", COMPONENT_WEIGHTS.PAPA],
    ["GUE", COMPONENT_WEIGHTS.GUE],
  ]) {
    const traces = tracesByFramework[framework] ?? [];
    const decisive = traces.filter((t) => t.result === "PASS" || t.result === "FAIL");
    const score = decisive.length === 0 ? 0 : (decisive.filter((t) => t.result === "PASS").length / decisive.length) * weight;
    componentScores[framework.toLowerCase()] = Math.round(score * 100) / 100;
    total += score;
  }

  return { total: Math.round(total * 100) / 100, componentScores };
}

/**
 * Ranks a run's classified instruments within each (direction, tier) pair,
 * per shared-gates.yaml: "within_same_direction_and_tier_only: true".
 *
 * @param {{ instrumentId: string, direction: string, tier: string, score: number, componentScores: object }[]} items
 */
export function rankWithinTiers(items) {
  const groups = new Map();
  for (const item of items) {
    const key = `${item.direction ?? "none"}::${item.tier}`;
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(item);
  }

  const ranked = [];
  for (const group of groups.values()) {
    group.sort((a, b) => b.score - a.score);
    group.forEach((item, i) => ranked.push({ ...item, rankWithinTier: i + 1 }));
  }
  return ranked;
}

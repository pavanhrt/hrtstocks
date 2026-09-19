// Corporate-action price/volume adjustment for raw bars, closing problem
// #20 (pivots/patterns currently run on raw, unadjusted data with no
// adjustment boundary at all).
//
// SCOPE DISCLOSURE (this project has no corporate-action data flowing into
// it yet -- the `corporate_actions` table exists in the schema but nothing
// populates it): this implements the standard *multiplicative*
// back-adjustment used for splits and bonus issues, where a documented
// `factor` is the price multiplier applied to every bar strictly before the
// action's ex_date (and its reciprocal applied to volume, since a split
// that halves the price doubles the share count trading at that price).
// Cash dividends use a different (additive, or total-return) adjustment
// convention that is NOT implemented here -- a dividend-type action is
// intentionally left unadjusted (factor effectively 1) rather than guessing
// its treatment. This is a disclosed PROJECT_DEFAULT, not a documented
// specification, because no source document for this decision has been
// supplied to the project yet.

export const ADJUSTMENT_VERSION = "1.0.0-splits-bonus-only";

const MULTIPLICATIVE_ACTION_TYPES = new Set(["split", "bonus"]);

/**
 * @param {import("../providers/types.js").Bar[]} dailyBars oldest-first
 * @param {{action_type: string, ex_date: string, factor: number|null}[]} corporateActions
 * @returns {import("../providers/types.js").Bar[]} same bars, price/volume adjusted, oldest-first
 */
export function computeAdjustedBars(dailyBars, corporateActions) {
  const applicable = (corporateActions ?? [])
    .filter((a) => MULTIPLICATIVE_ACTION_TYPES.has(a.action_type) && Number.isFinite(a.factor) && a.factor > 0)
    .sort((a, b) => (a.ex_date < b.ex_date ? -1 : 1));

  if (applicable.length === 0) {
    return dailyBars.map((b) => ({ ...b }));
  }

  return dailyBars.map((bar) => {
    // Every action whose ex_date is strictly after this bar's date affects
    // it -- the bar predates that action taking effect, so it needs scaling
    // to stay comparable with bars after it. Multiple qualifying actions
    // compound multiplicatively (standard back-adjustment).
    const cumulativeFactor = applicable.reduce((acc, action) => (bar.date < action.ex_date ? acc * action.factor : acc), 1);
    if (cumulativeFactor === 1) return { ...bar };
    return {
      ...bar,
      open: bar.open * cumulativeFactor,
      high: bar.high * cumulativeFactor,
      low: bar.low * cumulativeFactor,
      close: bar.close * cumulativeFactor,
      volume: bar.volume / cumulativeFactor,
    };
  });
}

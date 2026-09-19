// Gate M8/S8 -- reward:risk, wired against whichever M5 route's own
// documented entry/stop/target evidence exists (hourly-routes.js already
// computes stops/targets per route; this is pure arithmetic over that
// existing data, not a new source reading).
//
// "Take conservative targets for better money management" (BUY...§6 check
// 12) -- when a route exposes multiple targets (BUY-1/SELL-3's 1.62x/2.62x/
// 4.25x ratios), this uses the NEAREST one, the conservative choice per that
// same instruction, not the most optimistic.
//
// swing_minimum_reward_risk_strict (config/parameters.yaml, resolved in
// architecture-plan.md §7 decision 1): a STRICT `> 3`, matching every source
// document's own explicit "2.6 fails, do not round up" warning -- never the
// existing (inclusive `>=`) minimum_reward_risk used by other strategies.

const REWARD_RISK_LOCATOR = "BUY_Signal_Playbook_Weekly_Daily_1H.md §7 / SELL_Signal_Playbook_Weekly_Daily_1H.md §9";

/** The single structural stop a route's own evidence implies, or null when the route carries none. */
function stopFromRoute(route) {
  if (route.stops?.structural != null) return route.stops.structural; // BUY-1/SELL-3
  if (typeof route.stop === "number") return route.stop; // BUY-4/SELL-4, SELL-1
  return null;
}

/** The nearest (most conservative) target a route's own evidence implies, or null when none is computed. */
function nearestTargetFromRoute(route, bullish, entryPrice) {
  if (Array.isArray(route.targets)) {
    // BUY-1/SELL-3's WAVE_TARGET_RATIOS array -- pick the one closest to entry.
    const candidates = route.targets.filter((t) => (bullish ? t > entryPrice : t < entryPrice));
    if (candidates.length === 0) return null;
    return bullish ? Math.min(...candidates) : Math.max(...candidates);
  }
  if (route.targets?.nearestDailySupport?.price != null) return route.targets.nearestDailySupport.price; // SELL-1
  if (route.targets?.nearestDailyResistance?.price != null) return route.targets.nearestDailyResistance.price;
  return null; // BUY-4/SELL-4: the source names "the BUY-1 wave-3 objectives" but this route doesn't compute its own target
}

/**
 * @param {object} params
 * @param {object|null} params.route the M5 route detector's own result object for whichever route was selected
 * @param {boolean} params.bullish
 * @param {number|null} params.currentPrice latest hourly close, used as the entry price when the route has no discrete trigger close of its own (e.g. BUY-4/SELL-4's pattern-based entry)
 * @param {number} params.minimumRewardRiskStrict config/parameters.yaml swing_minimum_reward_risk_strict
 * @returns {{entryPrice: number, structuralStop: number, conservativeTarget: number, risk: number, reward: number, rewardRiskRatio: number, passes: boolean}|null}
 *   null when the route has no computable stop/target -- never a guessed number
 */
export function computeRewardRisk({ route, bullish, currentPrice, minimumRewardRiskStrict }) {
  if (!route) return null;
  const entryPrice = route.trigger?.close ?? currentPrice;
  const structuralStop = stopFromRoute(route);
  const conservativeTarget = nearestTargetFromRoute(route, bullish, entryPrice);
  if (entryPrice == null || structuralStop == null || conservativeTarget == null) return null;

  const risk = bullish ? entryPrice - structuralStop : structuralStop - entryPrice;
  const reward = bullish ? conservativeTarget - entryPrice : entryPrice - conservativeTarget;
  if (risk <= 0) return { entryPrice, structuralStop, conservativeTarget, risk, reward, rewardRiskRatio: null, passes: false }; // "risk must be positive" -- an invalid stop, never divide by a non-positive risk

  const rewardRiskRatio = reward / risk;
  return { entryPrice, structuralStop, conservativeTarget, risk, reward, rewardRiskRatio, passes: rewardRiskRatio > minimumRewardRiskStrict };
}

export { REWARD_RISK_LOCATOR };

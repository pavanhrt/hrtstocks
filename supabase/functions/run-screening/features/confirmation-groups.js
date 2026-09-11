// The 5 independent confirmation groups (>=4-of-5 gate) --
// swing-strategy-extraction.md §5, resolved as a disclosed PROJECT_DEFAULT
// synthesis in architecture-plan.md §7 decision 3: "This concept does not
// exist in the same form in the primary swing playbooks... the 5 groups are
// a disclosed PROJECT_DEFAULT synthesis layer this project defines, each
// populated from checks the primary playbook already documents per route...
// not new invented thresholds." The group NAMES come from
// buy-conditions.md/sell-conditions.md's own "Independent confirmation
// groups" section; each group's MEMBERSHIP is populated from evidence this
// codebase already computes elsewhere in the swing pipeline (route
// detectors, M6/M7 evidence, the ADX combination-matrix condition) -- never
// a new indicator, never an invented threshold. Every group cites its real
// source locator, per that decision's own requirement.
//
// The swing playbooks' own equivalent grading mechanism (the 100-point/
// 5-block scorecard, §5) is NOT implemented by this module -- that remains a
// separate, unresolved mechanism per swing-strategy-extraction.md §13
// conflict #3. This module implements ONLY the cross-check documents'
// "at least 4 of these 5 groups" binary gate, applied AFTER all 8 mandatory
// gates and the selected route already pass, per that section's own
// sequencing ("After all mandatory gates and the chosen route pass...").

const CONFIRMATION_GROUPS_LOCATOR =
  "buy-conditions.md/sell-conditions.md 'Independent confirmation groups' (swing-strategy-extraction.md §5, architecture-plan.md §7 decision 3)";

/** Fibonacci-depth evidence already computed by whichever M5 route detector matched -- shape differs per route, so this extracts whichever field that route actually provides. */
function fibonacciCheckFromRoute(route) {
  if (!route) return null;
  if (typeof route.withinFibBand === "boolean") return route.withinFibBand; // BUY-4/SELL-4 (Wave 2 Pullback/Bounce Failure)
  if (route.wave2RetracementFraction != null) return route.wave2RetracementFraction >= 0.382 && route.wave2RetracementFraction <= 0.618; // BUY-1/SELL-3 (Wave 3 Ignition)
  return null; // SELL-1 (Wave 5 Exhaustion) has no wave-2-retracement check of its own
}

/** Hour-slot volume evidence already computed by whichever M5 route detector matched. */
function volumeCheckFromRoute(route) {
  if (!route) return false;
  if (route.volume?.triggerAboveHourSlotAverage === true) return true; // BUY-1/SELL-3
  if (route.waveVolumeComparison?.wave3ExceedsWave5 === true) return true; // SELL-1
  return false;
}

/**
 * @param {object} params
 * @param {boolean} params.directionLockPassed WBP-M1..M4/WSP-S1..S4 all PASS (features/swing-analysis.js#directionLockPassed)
 * @param {object|null} params.selectedRoute the M5 route detector's own result object for whichever route was selected (hourly-routes.js), or null
 * @param {boolean} params.papaFormationTriggered whether any M6 PAPA formation (features/papa-formations.js) TRIGGERED same-direction this run
 * @param {object|null} params.smmHat features/smm-hat.js#evaluateSmmHat's result, or null
 * @param {{wait: boolean}|null} params.adxCondition features/hourly-conditions.js#evaluateHourlyAdxCondition's result, or null
 * @returns {{groups: object, passedCount: number, passed: boolean}}
 */
export function evaluateConfirmationGroups({ directionLockPassed, selectedRoute, papaFormationTriggered, smmHat, adxCondition }) {
  const groups = {};

  // 1. Structure and level -- swing-strategy-extraction.md §5's own note:
  // this cross-check group "spans the swing playbook's mandatory gates
  // M1-M6 rather than being a scored block at all."
  const structureSupportive = Boolean(directionLockPassed && selectedRoute?.requiredChecksPassed);
  groups.structureAndLevel = {
    supportive: structureSupportive,
    reason: !directionLockPassed
      ? "M1-M4 direction lock has not passed"
      : selectedRoute?.requiredChecksPassed
        ? "M1-M4 direction lock passed and the selected M5 route's own required structural checks all passed"
        : "M1-M4 direction lock passed, but no M5 route has confirmed all required structural checks yet",
    locator: CONFIRMATION_GROUPS_LOCATOR + "; group 1",
  };

  // 2. EMA and Fibonacci -- BUY...§9 Block D "Pattern, EMA and Fibonacci" /
  // SELL...§11 Block D; smm-decision-sheet-SKILL.md checks 3 (EMA crossover) and 5 (Fibonacci depth).
  const fibResult = fibonacciCheckFromRoute(selectedRoute);
  const emaResult = smmHat?.checks?.emaCrossover === true;
  groups.emaAndFibonacci = {
    supportive: Boolean(fibResult || emaResult),
    reason: `route Fibonacci-band check: ${fibResult === null ? "not applicable to the selected route" : fibResult}; M7 EMA 5/13-26 crossover: ${smmHat?.checks?.emaCrossover ?? "not computed"}`,
    locator: "BUY_Signal_Playbook_Weekly_Daily_1H.md §9 Block D / SELL...§11 Block D; smm-decision-sheet-SKILL.md checks 3 and 5",
  };

  // 3. Momentum -- Block A/E (MACD Tide, RSI/Stochastic), reusing M7's own Step 1/Step 2 readings.
  groups.momentum = {
    supportive: Boolean(smmHat?.step1?.reading && smmHat?.step2?.reading),
    reason: `M7 Step 1 (daily MACD Tide) reading: ${smmHat?.step1?.reading ?? "null"}; Step 2 (hourly Stochastic/RSI) reading: ${smmHat?.step2?.reading ?? "null"}`,
    locator: "BUY_Signal_Playbook_Weekly_Daily_1H.md §9 Block A/E / SELL...§11 Block A/E",
  };

  // 4. Price action and pattern -- Block C (PAPA) + Block D (pattern), reusing M6's own trigger and M7 check 1.
  groups.priceActionAndPattern = {
    supportive: Boolean(papaFormationTriggered || smmHat?.checks?.candlestick),
    reason: `M6 PAPA formation TRIGGERED this run: ${Boolean(papaFormationTriggered)}; M7 check-1 candlestick: ${smmHat?.checks?.candlestick?.patternName ?? "none"}`,
    locator: "BUY_Signal_Playbook_Weekly_Daily_1H.md §9 Block C/D / SELL...§11 Block C/D",
  };

  // 5. Participation and regime -- volume + DMI/ADX, reusing whichever
  // route/M7 volume evidence exists plus the already-shipped ADX
  // combination-matrix condition. Missing ADX data (adxCondition === null,
  // not enough hourly bars yet) does not itself count against this group --
  // only an explicit WAIT verdict does; a missing volume check does count
  // against it, since volume evidence should already exist whenever a route
  // or M7 has evaluated at all.
  const volumeSupportive = volumeCheckFromRoute(selectedRoute) || smmHat?.checks?.volume?.aboveHourSlotAverage === true;
  const adxBlocks = adxCondition?.wait === true;
  groups.participationAndRegime = {
    supportive: Boolean(volumeSupportive && !adxBlocks),
    reason: `hour-slot volume supportive: ${volumeSupportive}; ADX/DMI combination-matrix: ${adxCondition ? (adxCondition.wait ? "WAIT" : "does not block") : "not computed yet"}`,
    locator: "buy-conditions.md/sell-conditions.md 'Participation and regime'; BUY...§9 Block B (volume)/Block C (DMI) / SELL...§11",
  };

  const passedCount = Object.values(groups).filter((g) => g.supportive).length;
  return { groups, passedCount, passed: passedCount >= 4 };
}

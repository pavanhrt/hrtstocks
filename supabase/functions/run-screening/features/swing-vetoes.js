// Vetoes -- "what kills a live signal" (BUY_Signal_Playbook_Weekly_Daily_1H.md
// §12 / SELL...§14, swing-strategy-extraction.md §6). Implements the subset
// checkable from evidence this cycle's own modules already compute: the
// three Elliott hard-rule breaks (reusing whichever route detector's own
// `origin`/`wave1`/`wave4` fields exist -- shapes differ per route, so each
// check is skipped, not guessed, when its required field is absent), a
// daily close below/above the last HL/LH, a weekly MACD histogram turn
// against the trade, reward:risk falling below the strict threshold, a
// break registering only on the gap (reuses hourly-routes.js's own
// `trigger.gapOnly`), and price closing back inside the pattern within 1-2
// bars of the break.
//
// Explicitly NOT implemented, disclosed per swing-strategy-extraction.md §6
// "Where the two veto lists diverge" / §13 conflict #10: the two
// cross-check-only vetoes with no matching line in the primary playbook's
// own kill-list ("EMA tangled and ADX shows a range while a trend route is
// claimed"; "monthly/weekly Elliott count invalid/ambiguous/terminal") --
// whether to adopt either as a veto (killing an already-live signal) rather
// than only a pre-entry WAIT condition is an open strategy-owner decision
// neither source document resolves.

const VETOES_LOCATOR = "BUY_Signal_Playbook_Weekly_Daily_1H.md §12 / SELL_Signal_Playbook_Weekly_Daily_1H.md §14";

function veto(id, reason, locator = VETOES_LOCATOR) {
  return { id, reason, locator };
}

/**
 * @param {object} params
 * @param {object|null} params.route the M5 route detector's own result object for whichever route was selected (hourly-routes.js)
 * @param {boolean} params.bullish
 * @param {object[]} params.hourlyBars oldest-first
 * @param {{state: string, lastSwingHigh: number|null, lastSwingLow: number|null}|null} params.dailyStructure features/structure.js#classifyDowStructure's own result on daily bars
 * @param {number|null} params.latestDailyClose
 * @param {string|null} params.weeklyMacdHistogramChange features/indicators.js#macdHistogramPhase(weeklyCloses,...).change
 * @param {number|null} params.rewardRiskRatio
 * @param {number|null} params.minimumRewardRiskStrict config/parameters.yaml swing_minimum_reward_risk_strict
 * @returns {object[]} every veto that fired, or [] when none did (never null -- an empty array is itself the honest "no vetoes triggered" answer)
 */
export function evaluateSwingVetoes({ route, bullish, hourlyBars, dailyStructure, latestDailyClose, weeklyMacdHistogramChange, rewardRiskRatio, minimumRewardRiskStrict }) {
  const vetoes = [];
  if (!route) return vetoes;

  // An hourly close below/above the origin of wave 1 -- rule 1 breaks, the count is dead.
  if (route.origin && hourlyBars?.length > 0) {
    const latestClose = hourlyBars[hourlyBars.length - 1].close;
    const breached = bullish ? latestClose < route.origin.price : latestClose > route.origin.price;
    if (breached) {
      vetoes.push(veto("wave1-origin-breach", `hourly close ${latestClose} ${bullish ? "below" : "above"} wave 1's origin (${route.origin.price}) -- rule 1 breaks, the count is dead`));
    }
  }

  // Wave 4 entering wave 1's territory -- rule 2 breaks. Only checkable for
  // route shapes that carry both wave1 and wave4 (SELL-1's shape today).
  if (route.wave1 && route.wave4) {
    const entersTerritory = bullish ? route.wave4.price < route.wave1.price : route.wave4.price > route.wave1.price;
    if (entersTerritory) {
      vetoes.push(veto("wave4-territory-breach", `wave 4 (${route.wave4.price}) entered wave 1's territory (${route.wave1.price}) -- rule 2 breaks, unless this is a diagonal`));
    }
  }

  // A break that registered only on the gap, with no confirmed intraday participation.
  if (route.trigger?.gapOnly) {
    vetoes.push(veto("gap-only-break", "the trigger close registered only on the overnight gap, with no confirmed intraday participation", VETOES_LOCATOR + "; §1.3/§3.1"));
  }

  // A daily close below the last Higher Low (bullish) / above the last Lower High (bearish).
  if (dailyStructure && latestDailyClose != null) {
    const level = bullish ? dailyStructure.lastSwingLow : dailyStructure.lastSwingHigh;
    if (level != null) {
      const breached = bullish ? latestDailyClose < level : latestDailyClose > level;
      if (breached) {
        vetoes.push(
          veto(
            "daily-structure-breach",
            `daily close ${latestDailyClose} ${bullish ? "below the last Higher Low" : "above the last Lower High"} (${level}) -- the daily ${bullish ? "uptrend" : "downtrend"} is over`
          )
        );
      }
    }
  }

  // The weekly MACD histogram turning against the trade -- "the Ocean has turned."
  if (weeklyMacdHistogramChange) {
    const turnsAgainst = bullish ? weeklyMacdHistogramChange === "downtick" : weeklyMacdHistogramChange === "uptick";
    if (turnsAgainst) {
      vetoes.push(veto("weekly-macd-turn", `weekly MACD histogram ${weeklyMacdHistogramChange} -- "the Ocean has turned"`));
    }
  }

  // Reward:risk fallen below the strict threshold (missed, not worse).
  if (rewardRiskRatio != null && minimumRewardRiskStrict != null && !(rewardRiskRatio > minimumRewardRiskStrict)) {
    vetoes.push(veto("reward-risk-below-threshold", `reward:risk ${rewardRiskRatio.toFixed(2)} is not strictly above ${minimumRewardRiskStrict} -- missed, not worse`));
  }

  // Price closing back on the wrong side of the trigger level within 1-2
  // bars of the break. Only checkable for a level-break route (BUY-1/SELL-3
  // via wave1, SELL-1 via wave4) -- BUY-4/SELL-4's trigger is a candlestick
  // pattern at a retracement level, not a discrete level break, so this
  // veto is naturally inapplicable there (triggerLevel stays null).
  if (route.trigger?.confirmed && hourlyBars?.length > 0) {
    const triggerIndex = hourlyBars.findIndex((b) => b.date === route.trigger.barDate);
    const triggerLevel = route.wave1?.price ?? route.wave4?.price ?? null;
    if (triggerIndex !== -1 && triggerLevel != null) {
      const followUpBars = hourlyBars.slice(triggerIndex + 1, triggerIndex + 3); // within 1-2 bars of the break
      const closedBackInside = followUpBars.some((b) => (bullish ? b.close < triggerLevel : b.close > triggerLevel));
      if (closedBackInside) {
        vetoes.push(veto("closed-back-inside", "price closed back on the wrong side of the trigger level within 1-2 bars of the break"));
      }
    }
  }

  return vetoes;
}

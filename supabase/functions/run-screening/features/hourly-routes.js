// BUY-1 "Wave 3 Ignition" / SELL-3 "Wave 3-Down Ignition" -- the two routes
// swing-strategy-extraction.md calls "the flagship buy" and "the mirror of
// the flagship buy" (§2 BUY-1, §3 SELL-3), the most completely documented
// of the ten hourly Elliott setups (BUY-1..5/SELL-1..5) WBP-M5/WSP-S5 must
// eventually choose among. Implemented here first, alone -- BUY-2..5 and
// SELL-1,2,4,5 are NOT implemented (disclosed, never silently treated as
// "doesn't apply"). A caller must NOT treat this module's null result as
// proof no hourly setup exists at all -- only that THIS ONE doesn't, right
// now.
//
// Scope, deliberately: this checks BUY-1/SELL-3's REQUIRED conditions only
// (checks 6, 7, 8 in the source's own numbering -- trigger, volume,
// rule-3 forward-check -- plus rule-1, which features/wave.js's labelWave
// already enforces by construction whenever it reports an impulse
// hypothesis at all). The "quality" (non-required) checks -- wave-2 depth/
// alternation, hourly MACD positive/negative crossover near zero -- are NOT
// computed here; the source is explicit that they only ever grade an
// already-valid setup on the 100-point scorecard (Phase 4 REMAINING), never
// gate it.

import { zigzagPivotsWithUnconfirmedLeg, labelPivotSequence, zigzagPivots } from "./structure.js";
import { labelWave } from "./wave.js";
import { hourSlotAverageVolume } from "./indicators.js";

// "1.62x/2.62x/4.25x wave 1 from the end of wave 2" -- swing-strategy-extraction.md
// §2 BUY-1 targets, mirrored bearish in §3 SELL-3.
const WAVE_TARGET_RATIOS = [1.62, 2.62, 4.25];

/**
 * @param {object} params
 * @param {object[]} params.hourlyBars oldest-first, nse-calendar.js's normalizeHourlyBars() shape (date/ts/sessionDate/slotIndex/OHLCV)
 * @param {object[]} params.dailyBars oldest-first daily bars (date/OHLCV) -- for the gap-vs-previous-close check and the daily-resistance forward check
 * @param {boolean} params.bullish true evaluates BUY-1, false evaluates SELL-3
 * @param {number} params.hourlyZigzagPct
 * @param {number} params.dailyZigzagPct
 * @param {number} params.hourSlotVolumeLookbackSessions
 * @returns {object|null} null when the wave-3-forming shape this route needs isn't present on the hourly chart at all; otherwise a structured result with every documented required check's real observed values
 */
export function detectWave3Ignition({ hourlyBars, dailyBars, bullish, hourlyZigzagPct, dailyZigzagPct, hourSlotVolumeLookbackSessions }) {
  if (hourlyBars.length < 2) return null;

  const { confirmed: rawPivots, unconfirmedLeg } = zigzagPivotsWithUnconfirmedLeg(hourlyBars, hourlyZigzagPct);
  const labeledPivots = labelPivotSequence(rawPivots);
  // labelWave only needs to know WHICH direction to test an impulse
  // against -- classifyDowStructure's own multi-pivot Dow read (which needs
  // 2+ confirmed highs AND 2+ confirmed lows to say anything but
  // "ambiguous") is the wrong tool here: a fresh wave-3-forming setup is, by
  // definition, only 3 confirmed pivots deep (origin + wave 1 + wave 2) --
  // exactly the sparse case classifyDowStructure calls ambiguous. This
  // module is testing a specific directional hypothesis (the `bullish`
  // parameter), not asking "what is this hourly chart's general trend," so
  // it supplies that hypothesis directly -- the same pattern wave.test.js's
  // own fixtures already use.
  const { primary, alternative } = labelWave(labeledPivots, unconfirmedLeg, bullish ? "uptrend_intact" : "downtrend_intact");

  const wantDirection = bullish ? "bullish" : "bearish";
  const candidate = [primary, alternative].find(
    (w) => w && w.structureType === "impulse" && w.direction === wantDirection && w.currentWave === "3" && w.waveState === "forming"
  );
  if (!candidate || !candidate.pivotPrices || candidate.pivotPrices.length < 3) return null;

  const [origin, wave1, wave2] = candidate.pivotPrices;
  const wave1Length = Math.abs(wave1.price - origin.price);

  const originIndex = hourlyBars.findIndex((b) => b.date === origin.date);
  const wave1Index = hourlyBars.findIndex((b) => b.date === wave1.date);
  const wave2Index = hourlyBars.findIndex((b) => b.date === wave2.date);
  const route = bullish ? "BUY-1" : "SELL-3";
  if (originIndex === -1 || wave1Index === -1 || wave2Index === -1) {
    // Should not happen (the pivots came from this same hourlyBars array),
    // but never assume -- report honestly rather than compute against a
    // pivot that can't actually be located.
    return {
      route,
      state: "forming",
      origin,
      wave1,
      wave2,
      trigger: null,
      volume: null,
      ruleThreeForwardCheck: null,
      stops: null,
      targets: null,
      requiredChecksPassed: false,
      reason: "could not locate one of the labeled pivots' own bars in the hourly series",
    };
  }

  // Trigger (check 6): the first hourly close, after wave 2's own bar, that
  // clears wave 1's price -- "not the same event as price merely
  // approaching that level."
  const barsSinceWave2 = hourlyBars.slice(wave2Index + 1);
  const triggerBar = barsSinceWave2.find((b) => (bullish ? b.close > wave1.price : b.close < wave1.price));

  let trigger = null;
  if (triggerBar) {
    // Gap/first-candle rule (swing-strategy-extraction.md §9): the source
    // offers two undocumented-preference alternatives -- "wait for the
    // second hourly candle" or "measure the break against the previous
    // session's close and say you did." This module implements the second
    // (a disclosed PROJECT_DEFAULT, architecture-plan.md §7/§8): a
    // first-candle-of-the-session close that clears wave 1 only counts as a
    // real trigger if the PRIOR session's own daily close had already
    // cleared that level too -- otherwise the "break" was manufactured
    // purely by the overnight gap, not real intraday participation.
    const isFirstCandleOfSession = triggerBar.slotIndex === 0;
    let gapOnly = false;
    if (isFirstCandleOfSession) {
      const priorDailyBar = [...dailyBars].reverse().find((d) => d.date < triggerBar.sessionDate);
      const priorCloseClearedLevel = priorDailyBar ? (bullish ? priorDailyBar.close > wave1.price : priorDailyBar.close < wave1.price) : false;
      gapOnly = !priorCloseClearedLevel;
    }
    trigger = {
      barDate: triggerBar.date,
      close: triggerBar.close,
      isFirstCandleOfSession,
      gapOnly,
      confirmed: !gapOnly,
    };
  }

  // Volume (check 7, required): trigger candle above its own hour-slot
  // average, AND wave 3's volume so far exceeds wave 1's own volume.
  let volume = null;
  if (trigger && trigger.confirmed) {
    const hourSlotAverage = hourSlotAverageVolume(hourlyBars, triggerBar, hourSlotVolumeLookbackSessions);
    const wave1Volume = hourlyBars.slice(originIndex + 1, wave1Index + 1).reduce((sum, b) => sum + b.volume, 0);
    const wave3VolumeSoFar = hourlyBars.slice(wave2Index + 1, hourlyBars.indexOf(triggerBar) + 1).reduce((sum, b) => sum + b.volume, 0);
    volume = {
      triggerVolume: triggerBar.volume,
      hourSlotAverage,
      triggerAboveHourSlotAverage: hourSlotAverage == null ? null : triggerBar.volume > hourSlotAverage,
      wave1Volume,
      wave3VolumeSoFar,
      wave3ExceedsWave1Volume: wave3VolumeSoFar > wave1Volume,
    };
  }

  // Rule-3 forward-check (check 8, required): the minimum viable wave-3
  // target (end of wave 2 +/- the length of wave 1) must sit at/beyond the
  // nearest major daily resistance/support -- otherwise the setup has no
  // real room before it collides with higher-timeframe structure.
  const minViableTarget = bullish ? wave2.price + wave1Length : wave2.price - wave1Length;
  const dailyPivots = zigzagPivots(dailyBars, dailyZigzagPct);
  const currentPrice = hourlyBars[hourlyBars.length - 1].close;
  const nearestDailyLevel = bullish
    ? dailyPivots.filter((p) => p.type === "high" && p.price >= currentPrice).sort((a, b) => a.price - b.price)[0] ?? null
    : dailyPivots.filter((p) => p.type === "low" && p.price <= currentPrice).sort((a, b) => b.price - a.price)[0] ?? null;
  const ruleThreeForwardCheck = {
    minViableTarget,
    nearestDailyLevel: nearestDailyLevel ? { price: nearestDailyLevel.price, date: nearestDailyLevel.date } : null,
    // No daily level found beyond the current price at all -- open sky, so
    // there's nothing for the minimum target to fail to reach.
    passes: nearestDailyLevel == null ? true : bullish ? minViableTarget >= nearestDailyLevel.price : minViableTarget <= nearestDailyLevel.price,
  };

  const stops = { tight: wave2.price, structural: origin.price };
  const targets = WAVE_TARGET_RATIOS.map((ratio) => (bullish ? wave2.price + ratio * wave1Length : wave2.price - ratio * wave1Length));

  const requiredChecksPassed = Boolean(
    trigger?.confirmed && volume?.triggerAboveHourSlotAverage && volume?.wave3ExceedsWave1Volume && ruleThreeForwardCheck.passes
  );

  return {
    route,
    state: "forming",
    origin,
    wave1,
    wave2,
    wave2RetracementFraction: candidate.ruleArithmetic?.wave2RetracementFraction ?? null,
    trigger,
    volume,
    ruleThreeForwardCheck,
    stops,
    targets,
    requiredChecksPassed,
  };
}

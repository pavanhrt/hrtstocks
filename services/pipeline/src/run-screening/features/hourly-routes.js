// Hourly Elliott setup detectors -- BUY-1..BUY-5 / SELL-1..SELL-5, the ten
// entry routes swing-strategy-extraction.md's §2/§3 document for gate
// WBP-M5/WSP-S5. Implemented incrementally, one mirror pair at a time. A
// caller must NOT treat any detector's null/false result as proof no hourly
// setup exists at all -- only that THIS ONE doesn't, right now. Implemented
// so far:
//
//   - detectWave3Ignition: BUY-1 "Wave 3 Ignition" / SELL-3 "Wave 3-Down
//     Ignition" -- the source calls these "the flagship buy" and "the
//     mirror of the flagship buy" (§2 BUY-1, §3 SELL-3), the most
//     completely documented pair.
//   - detectWave2Pullback: BUY-4 "Wave 2 Pullback" / SELL-4 "Bounce
//     Failure" -- both are a counter-trend retracement into the 38.2-61.8%
//     Fibonacci band of the prior leg, failing there on a PAPA reversal
//     trigger, resuming the dominant trend (§4 BUY-4 / §4 SELL-4 -- SELL-4
//     doesn't use Elliott wave-2 labeling in its own text, but is the same
//     structural setup described generically).
//   - detectWave5Exhaustion: SELL-1 "Wave 5 Exhaustion" -- a completed
//     bullish 5-wave impulse (all 3 GUE hard gates satisfied) whose 5th wave
//     shows weaker momentum than the 3rd (or truncates below wave 3's own
//     top), confirmed by hourly RSI divergence and a hour-slot volume
//     falloff, entered on an hourly close below wave 4's low (§3 SELL-1).
//     There is no bullish mirror in the source -- SELL-1 is a standalone
//     top-exhaustion route, not one half of a BUY-1-style pair.
//
// NOT implemented: BUY-2 (Wave 4 Completion), BUY-3/SELL-2 (Ending Diagonal
// Reversal/Breakdown), BUY-5/SELL-5 (Continuation Add). Three different kinds
// of gap, each disclosed rather than guessed past:
//   - BUY-2's documented trigger ("an hourly close above the wave-4 high")
//     is genuinely ambiguous in what swing-strategy-extraction.md
//     transcribes -- wave 4 is itself a low-type pivot in a bullish impulse,
//     so "the wave-4 high" cannot literally mean wave 4's own price without
//     more context from the fuller source table (§4.3) than this project
//     has read. Implementing it on a guessed interpretation would violate
//     this project's own never-invent discipline; it stays undone until
//     that table is available.
//   - BUY-3/SELL-2 require "two boundary lines through actual pivots,
//     extended forward, confirmed converging" (gue-ending-diagonal-SKILL.md
//     §0) -- unlike every other numeric gap this codebase has resolved as a
//     disclosed PROJECT_DEFAULT (a stated range with no fixed point, e.g.
//     conflict #9's own "15-20 candles"), this is a METHODOLOGICAL gap: no
//     source document specifies which pivots anchor each boundary line, over
//     what span, or by what fitting method. A least-squares regression (or
//     any other fitting choice) would be inventing a procedure the source
//     never describes, not merely picking a disclosed point in a stated
//     range -- a materially different, larger kind of guess this project's
//     never-invent discipline does not cover picking a default for. Stays
//     undone pending a real worked example from the strategy owner.
//   - BUY-5/SELL-5 have zero numeric checks anywhere in the source (entirely
//     structural/qualitative, "an already-confirmed running wave 3") -- no
//     range exists to pick a disclosed default from at all.

import { zigzagPivotsWithUnconfirmedLeg, labelPivotSequence, zigzagPivots } from "./structure.js";
import { labelWave } from "./wave.js";
import { hourSlotAverageVolume, rsi } from "./indicators.js";
import { detectCandlestickPatterns } from "./patterns.js";

// "1.62x/2.62x/4.25x wave 1 from the end of wave 2" -- swing-strategy-extraction.md
// §2 BUY-1 targets, mirrored bearish in §3 SELL-3.
const WAVE_TARGET_RATIOS = [1.62, 2.62, 4.25];

// "wave-2 retracement of 38.2-61.8% of wave 1 (50%/61.8% ideal)" --
// swing-strategy-extraction.md §4 BUY-4 check 3, mirrored in SELL-4 check 2.
const PULLBACK_FIB_BAND = [0.382, 0.618];

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

/**
 * BUY-4 "Wave 2 Pullback" / SELL-4 "Bounce Failure" -- checks the three
 * REQUIRED conditions (rule-1 arithmetic is again inherited for free from
 * wave.js's own impulse validation, which never reports a wave-2-forming
 * hypothesis unless the leg hasn't yet retraced 100%+ of wave 1):
 *
 *   1. A wave-2-forming shape is present (structureType='impulse',
 *      currentWave='2', waveState='forming').
 *   2. The CURRENT retracement level (the running extreme of the still-
 *      forming pullback, i.e. unconfirmedLeg) sits within the documented
 *      38.2-61.8% Fibonacci band of wave 1's length, and has not breached
 *      wave 1's own origin (check 3 / SELL-4 check 2). SELL-4's own extra
 *      "wave b may not exceed 78% of wave a" structural check (its check 6)
 *      needs no separate code: 61.8% is already strictly tighter than 78%,
 *      so the Fib-band check alone satisfies it.
 *   3. A same-direction TRIGGERED candlestick pattern (features/patterns.js)
 *      fired at some point during that still-forming pullback -- "a bullish
 *      [bearish] reversal trigger prints at that Fibonacci level" (BUY-4
 *      check 4 / SELL-4 check 4, both required, both citing the PAPA
 *      trigger catalogue).
 *
 * NOT computed: the "quality" (non-required) EMA/daily-resistance
 * confluence check (BUY-4 check 5 / SELL-4 check 3) and volume-contraction
 * check (SELL-4 check 5) -- same "grades, never gates" reasoning as
 * detectWave3Ignition's own scope note.
 *
 * @param {object} params
 * @param {object[]} params.hourlyBars oldest-first, nse-calendar.js's normalizeHourlyBars() shape
 * @param {boolean} params.bullish true evaluates BUY-4, false evaluates SELL-4
 * @param {number} params.hourlyZigzagPct
 * @returns {object|null} null when no wave-2-forming shape is present on the hourly chart at all
 */
export function detectWave2Pullback({ hourlyBars, bullish, hourlyZigzagPct }) {
  if (hourlyBars.length < 2) return null;

  const { confirmed: rawPivots, unconfirmedLeg } = zigzagPivotsWithUnconfirmedLeg(hourlyBars, hourlyZigzagPct);
  const labeledPivots = labelPivotSequence(rawPivots);
  // Same reasoning as detectWave3Ignition: supply the target direction
  // directly rather than deriving it from classifyDowStructure, which would
  // read "ambiguous" this early (only 2 confirmed pivots -- origin + wave 1
  // -- exist while wave 2 is still forming).
  const { primary, alternative } = labelWave(labeledPivots, unconfirmedLeg, bullish ? "uptrend_intact" : "downtrend_intact");

  const wantDirection = bullish ? "bullish" : "bearish";
  const candidate = [primary, alternative].find(
    (w) => w && w.structureType === "impulse" && w.direction === wantDirection && w.currentWave === "2" && w.waveState === "forming"
  );
  if (!candidate || !candidate.pivotPrices || candidate.pivotPrices.length < 2 || !unconfirmedLeg) return null;

  const [origin, wave1] = candidate.pivotPrices;
  const wave1Length = Math.abs(wave1.price - origin.price);
  const route = bullish ? "BUY-4" : "SELL-4";

  const wave1Index = hourlyBars.findIndex((b) => b.date === wave1.date);
  if (wave1Index === -1 || wave1Length === 0) {
    return {
      route,
      state: "forming",
      origin,
      wave1,
      currentRetracementLevel: unconfirmedLeg.price,
      retracementFraction: null,
      withinFibBand: false,
      trigger: null,
      stop: null,
      requiredChecksPassed: false,
      reason: "could not locate wave 1's own bar in the hourly series, or wave 1 has zero length",
    };
  }

  // Check 3 (BUY-4) / check 2 (SELL-4), required: the current pullback
  // extreme's retracement fraction, and that it hasn't breached wave 1's
  // own origin.
  const currentRetracementLevel = unconfirmedLeg.price;
  const retracementFraction = Math.abs(wave1.price - currentRetracementLevel) / wave1Length;
  const breachedOrigin = bullish ? currentRetracementLevel <= origin.price : currentRetracementLevel >= origin.price;
  const withinFibBand = !breachedOrigin && retracementFraction >= PULLBACK_FIB_BAND[0] && retracementFraction <= PULLBACK_FIB_BAND[1];

  // Check 4, required: a same-direction TRIGGERED candlestick pattern
  // printing at some point during this still-forming pullback (from wave
  // 1's own bar onward).
  const legBars = hourlyBars.slice(wave1Index + 1);
  const hits = detectCandlestickPatterns(hourlyBars, { lookback: Math.max(10, hourlyBars.length - wave1Index) });
  const triggerHit = hits.find((h) => h.state === "TRIGGERED" && h.direction === wantDirection && legBars.some((b) => b.date === h.triggerBarDate));
  const trigger = triggerHit ? { patternName: triggerHit.patternName, barDate: triggerHit.triggerBarDate } : null;

  const requiredChecksPassed = Boolean(withinFibBand && trigger);

  // Stops are NOT symmetric between the two sides, per their own documented
  // text: BUY-4's is "below the origin of wave 1" (the whole impulse's own
  // start -- a wide, structural stop); SELL-4's is "above the rally high"
  // (the bounce's own peak so far -- a much tighter stop specific to this
  // setup). Computed as documented for each side, not forced into a shared
  // shape.
  const stop = bullish ? origin.price : currentRetracementLevel;

  return {
    route,
    state: "forming",
    origin,
    wave1,
    currentRetracementLevel,
    retracementFraction,
    breachedOrigin,
    withinFibBand,
    trigger,
    stop,
    requiredChecksPassed,
  };
}

/**
 * SELL-1 "Wave 5 Exhaustion" -- no bullish mirror in the source (a
 * standalone top-exhaustion route, not one half of a BUY-1-style pair).
 * Requires a fully confirmed bullish 5-wave impulse (all 3 GUE hard gates
 * satisfied by construction, via wave.js's own validateImpulsePrefix), then
 * tests the documented exhaustion signature and entry.
 * @param {object} params
 * @param {object[]} params.hourlyBars oldest-first
 * @param {object[]} params.dailyBars oldest-first daily bars -- for the gap-vs-previous-close check and the nearest-daily-support target
 * @param {number} params.hourlyZigzagPct
 * @param {number} params.dailyZigzagPct
 * @param {number} params.hourSlotVolumeLookbackSessions
 * @returns {object|null} null when no completed bullish 5-wave impulse is present on the hourly chart at all
 */
export function detectWave5Exhaustion({ hourlyBars, dailyBars, hourlyZigzagPct, dailyZigzagPct, hourSlotVolumeLookbackSessions }) {
  if (hourlyBars.length < 2) return null;

  const { confirmed: rawPivots, unconfirmedLeg } = zigzagPivotsWithUnconfirmedLeg(hourlyBars, hourlyZigzagPct);
  const labeledPivots = labelPivotSequence(rawPivots);
  // Force the bullish-impulse hypothesis directly, same reasoning as
  // detectWave3Ignition/detectWave2Pullback: this route tests a specific
  // structural claim (a completed 5-up), not "what is the general trend."
  const { primary, alternative } = labelWave(labeledPivots, unconfirmedLeg, "uptrend_intact");
  const candidate = [primary, alternative].find(
    (w) => w && w.structureType === "impulse" && w.direction === "bullish" && w.currentWave === "5" && w.waveState === "completed"
  );
  if (!candidate || !candidate.pivotPrices || candidate.pivotPrices.length < 6) return null;

  const [origin, wave1, wave2, wave3, wave4, wave5] = candidate.pivotPrices;
  const route = "SELL-1";

  // Check 2, required: wave 5 made a new high on weaker strength than wave
  // 3, or has truncated (fails to exceed wave 3's own top).
  const wave3Length = wave3.price - wave2.price;
  const wave5Length = wave5.price - wave4.price;
  const weakerThanWave3 = wave5Length < wave3Length;
  const truncated = wave5.price <= wave3.price;
  const exhaustionSignature = { wave3Length, wave5Length, weakerThanWave3, truncated, passes: weakerThanWave3 || truncated };

  const wave2Index = hourlyBars.findIndex((b) => b.date === wave2.date);
  const wave3Index = hourlyBars.findIndex((b) => b.date === wave3.date);
  const wave4Index = hourlyBars.findIndex((b) => b.date === wave4.date);
  const wave5Index = hourlyBars.findIndex((b) => b.date === wave5.date);
  if (wave2Index === -1 || wave3Index === -1 || wave4Index === -1 || wave5Index === -1) {
    return {
      route,
      state: "completed",
      origin,
      wave1,
      wave2,
      wave3,
      wave4,
      wave5,
      exhaustionSignature,
      divergence: null,
      waveVolumeComparison: null,
      trigger: null,
      triggerVolumeCheck: null,
      stop: null,
      targets: null,
      requiredChecksPassed: false,
      reason: "could not locate one of the labeled pivots' own bars in the hourly series",
    };
  }

  // Check 3, required: hourly RSI divergence (price HH, oscillator LH) at
  // wave 5's own top vs wave 3's own top. Documented rsi_period=14
  // (config/parameters.yaml). Only the HOURLY reading is automated -- the
  // source's own required daily cross-check ("an hourly divergence that the
  // daily contradicts is close to worthless -- check the daily first") has
  // no daily-pivot-matching logic in this codebase and is NOT implemented;
  // disclosed here rather than silently assumed to agree.
  const RSI_PERIOD_FOR_DIVERGENCE = 14;
  const rsiAtWave3 = rsi(hourlyBars.slice(0, wave3Index + 1).map((b) => b.close), RSI_PERIOD_FOR_DIVERGENCE);
  const rsiAtWave5 = rsi(hourlyBars.slice(0, wave5Index + 1).map((b) => b.close), RSI_PERIOD_FOR_DIVERGENCE);
  const priceMadeHigherHigh = wave5.price > wave3.price;
  const oscillatorMadeLowerHigh = rsiAtWave3 != null && rsiAtWave5 != null ? rsiAtWave5 < rsiAtWave3 : null;
  const divergence = {
    rsiAtWave3,
    rsiAtWave5,
    priceMadeHigherHigh,
    oscillatorMadeLowerHigh,
    bearishDivergence: oscillatorMadeLowerHigh == null ? null : priceMadeHigherHigh && oscillatorMadeLowerHigh,
    dailyCrossCheckAutomated: false,
  };

  // Check 5, required: 3rd-wave hour-slot volume should exceed 5th-wave's
  // ("else suspect a fifth-wave extension and wait"). Summed raw volume
  // across each wave's own bars, same convention as detectWave3Ignition's
  // wave1Volume/wave3VolumeSoFar.
  const wave3Volume = hourlyBars.slice(wave2Index + 1, wave3Index + 1).reduce((sum, b) => sum + b.volume, 0);
  const wave5Volume = hourlyBars.slice(wave4Index + 1, wave5Index + 1).reduce((sum, b) => sum + b.volume, 0);
  const waveVolumeComparison = { wave3Volume, wave5Volume, wave3ExceedsWave5: wave3Volume > wave5Volume };

  // Trigger (check 7, required): the first hourly close, after wave 5's own
  // bar, that breaks below wave 4's low -- not on a gap alone (same
  // gap/first-candle PROJECT_DEFAULT as detectWave3Ignition: measure a
  // first-candle-of-session break against the prior session's own close).
  const barsAfterWave5 = hourlyBars.slice(wave5Index + 1);
  const triggerBar = barsAfterWave5.find((b) => b.close < wave4.price);
  let trigger = null;
  if (triggerBar) {
    const isFirstCandleOfSession = triggerBar.slotIndex === 0;
    let gapOnly = false;
    if (isFirstCandleOfSession) {
      const priorDailyBar = [...dailyBars].reverse().find((d) => d.date < triggerBar.sessionDate);
      const priorCloseClearedLevel = priorDailyBar ? priorDailyBar.close < wave4.price : false;
      gapOnly = !priorCloseClearedLevel;
    }
    trigger = { barDate: triggerBar.date, close: triggerBar.close, isFirstCandleOfSession, gapOnly, confirmed: !gapOnly };
  }

  // Check 8, required: volume on the trigger candle above its own hour-slot average.
  let triggerVolumeCheck = null;
  if (trigger && trigger.confirmed) {
    const hourSlotAverage = hourSlotAverageVolume(hourlyBars, triggerBar, hourSlotVolumeLookbackSessions);
    triggerVolumeCheck = {
      triggerVolume: triggerBar.volume,
      hourSlotAverage,
      triggerAboveHourSlotAverage: hourSlotAverage == null ? null : triggerBar.volume > hourSlotAverage,
    };
  }

  // Targets: the source names four, in priority order (depth of the prior
  // 4th wave one lesser degree; zigzag channel wave-c estimate; Fibonacci
  // c=a/1.62a/2.62a; nearest major daily support if nearer). The first three
  // all require sub-wave data (a corrective wave A/C) that does not exist
  // yet at entry time -- only the nearest-daily-support target is computed;
  // the rest are disclosed as not-yet-computed rather than guessed.
  const dailyPivots = zigzagPivots(dailyBars, dailyZigzagPct);
  const currentPrice = hourlyBars[hourlyBars.length - 1].close;
  const nearestDailySupport =
    dailyPivots.filter((p) => p.type === "low" && p.price <= currentPrice).sort((a, b) => b.price - a.price)[0] ?? null;
  const targets = {
    nearestDailySupport: nearestDailySupport ? { price: nearestDailySupport.price, date: nearestDailySupport.date } : null,
    depthOfPriorFourthWave: null,
    zigzagChannelWaveC: null,
    fibonacciFromWaveA: null,
    computedNote: "only nearestDailySupport is computed -- the other 3 documented targets need a corrective wave A/C that does not exist yet at entry time",
  };

  const stop = wave5.price; // above the wave-5 high, per the source

  const requiredChecksPassed = Boolean(
    exhaustionSignature.passes && divergence.bearishDivergence && waveVolumeComparison.wave3ExceedsWave5 && trigger?.confirmed && triggerVolumeCheck?.triggerAboveHourSlotAverage
  );

  return {
    route,
    state: "completed",
    origin,
    wave1,
    wave2,
    wave3,
    wave4,
    wave5,
    exhaustionSignature,
    divergence,
    waveVolumeComparison,
    trigger,
    triggerVolumeCheck,
    stop,
    targets,
    requiredChecksPassed,
  };
}

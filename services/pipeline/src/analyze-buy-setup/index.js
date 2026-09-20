// Buy-setup enrichment (Cloud Run Job) -- the three-timeframe gate + staged
// 15-minute enrichment for the /buy-setup-analysis page
// (strategies/buy-setup-analysis.yaml, PROJECT_DEFAULT/user-requested; see
// that file's decision record).
//
// Started by: the web app's POST /api/buy-setup-analysis route (Researcher+
// only, manual trigger), which launches this Cloud Run Job with RUN_ID (see
// ../jobs/buy-setup.mjs). The job runs the whole enrichment in ONE execution:
// the old Edge Function's wall-clock budget, self-chain handoff and cron
// recovery sweep are gone -- a Job may run for hours, and a failed execution is
// simply retried/re-run against the persisted batch state below.
//
// Transactional design (mirrored in migration 0011's own header comment):
// this is a SEPARATELY PUBLISHED ENRICHMENT STAGE, entirely independent of
// publish_screening_run()/run-screening's own tables.
//   1. Only ever runs against a run whose screening_runs.publication_state
//      is already 'published' -- refuses otherwise.
//   2. NEVER writes to screening_runs, instrument_run_results,
//      coverage_reconciliation, run_publication_manifests, rule_traces,
//      pattern_detections, analysis_bars, or elliott_hypotheses -- every
//      write below targets a dedicated buy_setup_* table (migration 0011).
//      A partial/failed enrichment is therefore structurally incapable of
//      corrupting or hiding the already-published main snapshot.
//   3. publish_buy_setup_enrichment(run_id) (a database RPC, migration 0011)
//      is the ONLY code allowed to flip buy_setup_manifests.enrichment_state
//      to 'published' -- it locks the manifest row, re-validates the full
//      snapshot transactionally, and only then flips state. This function
//      calls it once, after every batch is done; it never sets
//      enrichment_state = 'published' itself.
//
// Durability: mirrors run-screening's own pipeline_batches design
// (migration 0008) at a smaller scale -- buy_setup_pipeline_batches, claimed
// atomically (claim_next_buy_setup_batch), bounded attempts, stale-batch
// recovery (reset_stale_buy_setup_batches), a run-level lease
// (screening_run_leases, run_type='buy_setup_analysis') refreshed
// continuously via withLeaseHeartbeat while a batch is being processed. A
// killed execution is recoverable: the next execution (a retry, or a fresh
// click) resumes from whatever buy_setup_pipeline_batches/buy_setup_manifests
// state was last persisted --
// every write below is an idempotent upsert or a delete-then-reinsert scoped
// to exactly the row(s) being recomputed, never the whole run's evidence.

import { setTimeout as sleep } from "node:timers/promises";
import * as ops from "../db/ops.js";
import { FyersAuthError } from "../run-screening/providers/fyers-credentials.js";
import { safeErrorMessage } from "../security/redact.js";
import { acquireRunLease, heartbeatRunLease, releaseRunLease } from "../run-screening/run-lease.js";
import { fetchFifteenMinuteOHLCV } from "../run-screening/providers/fyers.js";
import { detectCandlestickPatterns, detectDoubleExtremePatterns, PATTERN_COVERAGE } from "../run-screening/features/patterns.js";
import { zigzagPivots } from "../run-screening/features/structure.js";
import {
  emaSeries,
  rsiSeries,
  stochasticSeries,
  adxSeries,
  macdLineAndSignalSeries,
  macdHistogramSeries,
  bollingerBandsSeries,
} from "../run-screening/features/indicators.js";
import { buildThreeTimeframeContext, evaluateThreeTimeframeGate, isQualifiedForFifteenMinuteAnalysis } from "../run-screening/buy-setup/three-timeframe-gate.js";
import { detectPositiveEmaCrossoverEvidence } from "../run-screening/buy-setup/ema-crossover.js";
import { findConfirmedPivots, detectSupportResistance, detectBreakout, detectChannel } from "../run-screening/buy-setup/chart-structure.js";
import { detectRsiBullishDivergence, detectMacdBullishDivergence } from "../run-screening/buy-setup/divergence.js";
import { normalizeCompletedFifteenMinuteBars } from "../run-screening/buy-setup/fifteen-minute-bars.js";
import { computeIntradayIndicators } from "../run-screening/buy-setup/intraday-indicators.js";
import { computeFifteenMinuteWave } from "../run-screening/buy-setup/fifteen-minute-wave.js";
import { resolveBuySetupParameters, emaCrossoverPeriods } from "../run-screening/buy-setup/parameters.js";
import { renderDailyChart, renderIntradayChart, BUY_SETUP_RENDER_VERSION } from "../run-screening/charts/render-buy-setup.js";
import { immutableChartIdentity } from "../run-screening/charts/immutable-path.js";
import { buildChunks } from "../run-screening/pipeline/chunks.js";

const RUN_TYPE = "buy_setup_analysis";
const LEASE_DURATION_MS = 3 * 60 * 1000;
const HEARTBEAT_INTERVAL_MS = 45 * 1000;
// Safety valve: give up on a run that has not finished after this long (override for slow providers).
const MAX_TOTAL_RUN_DURATION_MS = Number(process.env.BUY_SETUP_MAX_RUN_MINUTES ?? 40) * 60 * 1000;
const STALE_BATCH_AFTER_SECONDS = 480;
const MAX_CHUNK_ATTEMPTS = 3;
const INSTRUMENT_CONCURRENCY = 5; // lower than run-screening's 10: each qualified instrument now also does a 15-minute fetch
const GATE_CHUNK_SIZE = 100; // no network I/O per instrument in this stage -- larger chunks than a Fyers-bound one are safe
const FIFTEEN_MINUTE_CHUNK_SIZE = 20; // one Fyers fetch + several DB writes + two chart renders per instrument

async function withLeaseHeartbeat(db, runId, work) {
  const interval = setInterval(() => {
    heartbeatRunLease(db, RUN_TYPE, runId, { leaseDurationMs: LEASE_DURATION_MS }).catch(() => {});
  }, HEARTBEAT_INTERVAL_MS);
  try {
    return await work();
  } finally {
    clearInterval(interval);
  }
}

async function runWithConcurrencyLimit(items, limit, worker) {
  const results = new Array(items.length);
  let cursor = 0;
  async function next() {
    const i = cursor++;
    if (i >= items.length) return;
    results[i] = await worker(items[i], i);
    await next();
  }
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, next));
  return results;
}

// Database errors are surfaced with their real message (a plain object with a
// `message` was once recorded as the useless literal "[object Object]" in
// validation_errors, hiding the real Postgres error from anyone reading the
// manifest -- keep this tolerant of non-Error throwables).
function errorMessage(err) {
  return safeErrorMessage(err);
}

async function recordPersistenceError(db, runId, instrumentId, stage, err) {
  const message = errorMessage(err);
  await ops.insert(db, "buy_setup_persistence_errors", { run_id: runId, instrument_id: instrumentId, stage, error_message: message });
}

async function loadDailyBars(db, instrumentId, runDate) {
  const { data, error } = await ops.select(db, `select session_date, open, high, low, close, volume from market_bars_raw
        where instrument_id = $1
          and interval = $2
          and provider = $3
          and session_date <= $4
        order by session_date asc`, [instrumentId, "1d", "fyers", runDate], "many");
  if (error) throw error;
  return (data ?? []).map((b) => ({ date: b.session_date, open: b.open, high: b.high, low: b.low, close: b.close, volume: b.volume }));
}

async function storeChart(db, chartStore, runId, instrumentId, timeframe, svg) {
  const { objectPath, contentHash } = await immutableChartIdentity(instrumentId, `buy-setup-${timeframe}`, svg);
  await chartStore.putSvg(objectPath, svg); // immutable: an identical existing object is success
  await ops.upsert(db, "buy_setup_charts", { run_id: runId, instrument_id: instrumentId, timeframe, chart_object_path: objectPath, chart_content_hash: contentHash, chart_algorithm_version: BUY_SETUP_RENDER_VERSION }, { conflict: ["run_id", "instrument_id", "timeframe"] });
}

// ---------------------------------------------------------------------------
// Stage 1: three-timeframe gate, evaluated for the COMPLETE stock universe.
// ---------------------------------------------------------------------------

async function processGateBatch({ db, runId, runDate, instrumentIds, gateRules, params, monthlyByInstrument, weeklyByInstrument }) {
  await runWithConcurrencyLimit(instrumentIds, INSTRUMENT_CONCURRENCY, async (instrumentId) => {
    try {
      const dailyBars = await loadDailyBars(db, instrumentId, runDate);
      const context = buildThreeTimeframeContext({
        monthlyDowState: monthlyByInstrument.get(instrumentId)?.dowState ?? null,
        monthlyBreakoutUpWithVolume: monthlyByInstrument.get(instrumentId)?.breakoutUp ?? null,
        weeklyDowState: weeklyByInstrument.get(instrumentId)?.dowState ?? null,
        weeklyBreakoutUpWithVolume: weeklyByInstrument.get(instrumentId)?.breakoutUp ?? null,
        dailyBars,
        params: { zigzagDailyPct: params.zigzagDailyPct, volumeLookback: params.volumeLookback, volumeMultiplier: params.volumeMultiplier },
      });
      const { traces } = evaluateThreeTimeframeGate(gateRules, context);

      const { error } = await ops.upsert(db, "buy_setup_gate_traces", traces.map((t) => ({
          run_id: runId,
          instrument_id: instrumentId,
          rule_id: t.rule_id,
          rule_version: params.ruleVersion,
          parameter_version: params.parameterVersion,
          observed_values: t.observed_values,
          thresholds: t.thresholds,
          result: t.result,
          explanation: t.explanation,
        })), { conflict: ["run_id", "instrument_id", "rule_id"] });
      if (error) throw error;
    } catch (err) {
      await recordPersistenceError(db, runId, instrumentId, "gate", err);
    }
  });
}

// ---------------------------------------------------------------------------
// Stage 2: full daily + 15-minute analysis, for gate-qualified instruments only.
// ---------------------------------------------------------------------------

async function processFifteenMinuteBatch({ db, chartStore, runId, runDate, asOfTimestamp, instruments, params }) {
  await runWithConcurrencyLimit(instruments, INSTRUMENT_CONCURRENCY, (instrument) =>
    processQualifiedInstrument({ db, chartStore, runId, runDate, asOfTimestamp, instrument, params })
  );
}

async function processQualifiedInstrument({ db, chartStore, runId, runDate, asOfTimestamp, instrument, params }) {
  const dailyBars = await loadDailyBars(db, instrument.instrument_id, runDate);
  const { fastPeriod, slowPeriods } = emaCrossoverPeriods(params);

  // ---- Daily candlestick vs. chart patterns -- two separate detector
  // families, persisted into two separate tables, never merged. Multiple
  // detections per instrument are all persisted (not just the first).
  try {
    const candlestickHits = detectCandlestickPatterns(dailyBars);
    const { error } = await ops.remove(db, "buy_setup_candlestick_detections", { run_id: runId, instrument_id: instrument.instrument_id });
    if (error) throw error;
    if (candlestickHits.length > 0) {
      const { error: insertError } = await ops.insert(db, "buy_setup_candlestick_detections", candlestickHits.map((h) => ({
          run_id: runId,
          instrument_id: instrument.instrument_id,
          pattern_name: h.patternName,
          direction: h.direction,
          state: h.state,
          lifecycle_state: h.lifecycleState,
          anchor_points: h.anchorPoints,
          trigger_bar_ts: h.triggerBarDate,
          target_price: h.targetPrice,
          invalidation_price: h.invalidationPrice,
          volume_evidence: h.volumeEvidence,
          source_locator: h.sourceLocator,
        })));
      if (insertError) throw insertError;
    }
  } catch (err) {
    await recordPersistenceError(db, runId, instrument.instrument_id, "daily_patterns", err);
  }

  try {
    const chartPatternHits = detectDoubleExtremePatterns(zigzagPivots(dailyBars, params.zigzagDailyPct), dailyBars);
    const { error } = await ops.remove(db, "buy_setup_chart_pattern_detections", { run_id: runId, instrument_id: instrument.instrument_id });
    if (error) throw error;
    if (chartPatternHits.length > 0) {
      const { error: insertError } = await ops.insert(db, "buy_setup_chart_pattern_detections", chartPatternHits.map((h) => ({
          run_id: runId,
          instrument_id: instrument.instrument_id,
          pattern_name: h.patternName,
          direction: h.direction,
          state: h.state,
          lifecycle_state: h.lifecycleState,
          anchor_points: h.anchorPoints,
          trigger_bar_ts: h.triggerBarDate,
          target_price: h.targetPrice,
          invalidation_price: h.invalidationPrice,
          volume_evidence: h.volumeEvidence,
          source_locator: h.sourceLocator,
        })));
      if (insertError) throw insertError;
    }
  } catch (err) {
    await recordPersistenceError(db, runId, instrument.instrument_id, "daily_patterns", err);
  }

  let dailyEmaEvidence = null;
  try {
    dailyEmaEvidence = detectPositiveEmaCrossoverEvidence(dailyBars, { fastPeriod, slowPeriods, confirmationWindow: params.emaCrossoverConfirmationWindow });
    await upsertEmaCrossover(db, runId, instrument.instrument_id, "daily", dailyEmaEvidence, params);
  } catch (err) {
    await recordPersistenceError(db, runId, instrument.instrument_id, "daily_ema", err);
  }

  let support = null;
  let resistance = null;
  let breakout = null;
  let channel = null;
  try {
    ({ support, resistance } = detectSupportResistance(dailyBars, {
      pivotLeftWindow: params.pivotLeftWindow,
      pivotRightWindow: params.pivotRightWindow,
      tolerance: params.srTolerance,
      minTouches: params.srTouchCountMin,
    }));
    breakout = detectBreakout(dailyBars, resistance?.level ?? null, { breakoutBuffer: params.breakoutBuffer, volumeLookback: params.volumeLookback, volumeMultiplier: params.volumeMultiplier });
    const { highs: confirmedHighs, lows: confirmedLows } = findConfirmedPivots(dailyBars, params.pivotLeftWindow, params.pivotRightWindow);
    channel = detectChannel(confirmedHighs, confirmedLows, dailyBars.length - 1, { minPivots: params.channelMinPivots, slopeThreshold: params.channelSlopeThreshold });
    const { error: levelsError } = await ops.upsert(db, "buy_setup_chart_levels", {
        run_id: runId,
        instrument_id: instrument.instrument_id,
        support_level: support?.level ?? null,
        support_touch_count: support?.touchCount ?? null,
        resistance_level: resistance?.level ?? null,
        resistance_touch_count: resistance?.touchCount ?? null,
        breakout_detected: breakout.breakoutDetected,
        breakout_candle_ts: breakout.breakoutCandleDate,
        breakout_volume_confirmed: breakout.breakoutVolumeConfirmed,
        channel_type: channel.type,
        channel_upper: channel.upper,
        channel_lower: channel.lower,
        pivot_left_window: params.pivotLeftWindow,
        pivot_right_window: params.pivotRightWindow,
        parameter_version: params.parameterVersion,
      }, { conflict: ["run_id", "instrument_id"] });
    if (levelsError) throw levelsError;
  } catch (err) {
    await recordPersistenceError(db, runId, instrument.instrument_id, "chart_levels", err);
  }

  try {
    const dailyCloses = dailyBars.map((b) => b.close);
    const [candlestickHits, chartPatternHits] = await Promise.all([
      Promise.resolve(detectCandlestickPatterns(dailyBars)),
      Promise.resolve(detectDoubleExtremePatterns(zigzagPivots(dailyBars, params.zigzagDailyPct), dailyBars)),
    ]);
    const dailySvg = renderDailyChart({
      symbol: instrument.symbol,
      bars: dailyBars,
      ema: { fastPeriod, slowPeriod: slowPeriods[0], fastSeries: emaSeries(dailyCloses, fastPeriod), slowSeries: emaSeries(dailyCloses, slowPeriods[0]) },
      emaCrossover: dailyEmaEvidence ? { status: dailyEmaEvidence.overallStatus, crossoverBarDate: dailyEmaEvidence.perSlowPeriod.find((r) => r.status === "TRIGGERED")?.crossoverBarDate ?? null } : null,
      patterns: [...candlestickHits, ...chartPatternHits],
      support,
      resistance,
      breakout,
      channel,
    });
    await storeChart(db, chartStore, runId, instrument.instrument_id, "daily", dailySvg);
  } catch (err) {
    await recordPersistenceError(db, runId, instrument.instrument_id, "daily_chart", err);
  }

  // ---- 15-minute analysis ----
  let fifteenMinBars = [];
  try {
    const raw = await fetchFifteenMinuteOHLCV(instrument.instrument_id, instrument.symbol, db, { asOfTimestamp });
    fifteenMinBars = normalizeCompletedFifteenMinuteBars(raw.data, asOfTimestamp);
    if (fifteenMinBars.length > 0) {
      const { error: barsError } = await ops.upsert(db, "buy_setup_fifteen_minute_bars", fifteenMinBars.map((b) => ({
          run_id: runId,
          instrument_id: instrument.instrument_id,
          session_date: b.sessionDate,
          ts: b.ts,
          open: b.open,
          high: b.high,
          low: b.low,
          close: b.close,
          volume: b.volume,
          provider: "fyers",
          adjustment_state: "provider_adjusted",
          algorithm_version: "fyers-history-provider-adjusted-v1",
          provenance: { provider: "fyers", retrievedAt: raw.retrievedAt },
          is_complete: true,
          source_retrieved_at: raw.retrievedAt,
        })), { conflict: ["run_id", "instrument_id", "ts"] });
      if (barsError) throw barsError;
    }
  } catch (err) {
    // An expired/invalid FYERS token stops the whole run with a clear cause; it
    // must not be recorded once per instrument as if each had its own data problem.
    if (err instanceof FyersAuthError) throw err;
    await recordPersistenceError(db, runId, instrument.instrument_id, "fifteen_minute_bars", err);
  }

  let intradayEmaEvidence = null;
  try {
    intradayEmaEvidence = detectPositiveEmaCrossoverEvidence(fifteenMinBars, { fastPeriod, slowPeriods, confirmationWindow: params.emaCrossoverConfirmationWindow });
    await upsertEmaCrossover(db, runId, instrument.instrument_id, "15m", intradayEmaEvidence, params);
  } catch (err) {
    await recordPersistenceError(db, runId, instrument.instrument_id, "intraday_indicators", err);
  }

  let indicators = null;
  try {
    indicators = computeIntradayIndicators(fifteenMinBars, {
      rsiPeriod: params.rsiPeriod,
      stochasticLookback: params.stochasticLookback,
      stochasticSmoothing: params.stochasticSmoothing,
      bollingerLookback: params.bollingerLookback,
      bollingerDeviation: params.bollingerDeviation,
      adxDmiPeriod: params.adxDmiPeriod,
      macdFast: params.macdFast,
      macdSlow: params.macdSlow,
      macdSignal: params.macdSignal,
    });
    const { error: indicatorsError } = await ops.upsert(db, "buy_setup_intraday_indicators", {
        run_id: runId,
        instrument_id: instrument.instrument_id,
        evidence_candle_ts: indicators.evidenceCandleTs,
        rsi: indicators.rsi,
        rsi_previous: indicators.rsiPrevious,
        stochastic_k: indicators.stochasticK,
        stochastic_d: indicators.stochasticD,
        stochastic_k_previous: indicators.stochasticKPrevious,
        stochastic_d_previous: indicators.stochasticDPrevious,
        bollinger_upper: indicators.bollingerUpper,
        bollinger_middle: indicators.bollingerMiddle,
        bollinger_lower: indicators.bollingerLower,
        bollinger_status: indicators.bollingerStatus,
        plus_di: indicators.plusDi,
        minus_di: indicators.minusDi,
        adx: indicators.adx,
        macd_line: indicators.macdLine,
        macd_signal: indicators.macdSignal,
        macd_histogram: indicators.macdHistogram,
        macd_histogram_previous: indicators.macdHistogramPrevious,
        parameter_version: params.parameterVersion,
      }, { conflict: ["run_id", "instrument_id"] });
    if (indicatorsError) throw indicatorsError;
  } catch (err) {
    await recordPersistenceError(db, runId, instrument.instrument_id, "intraday_indicators", err);
  }

  let wave = null;
  try {
    wave = computeFifteenMinuteWave(fifteenMinBars, params.zigzagFifteenMinutePct);
    const { error } = await ops.upsert(db, "buy_setup_fifteen_minute_wave", {
        run_id: runId,
        instrument_id: instrument.instrument_id,
        structure_type: wave.structureType,
        current_wave: wave.currentWave,
        wave_state: wave.waveState,
        confidence: wave.confidence,
        rule_arithmetic: Object.fromEntries((wave.ruleEvidence ?? []).map((r) => [r.ruleId, r.observedValues])),
        rule_evidence: wave.ruleEvidence ?? [],
        invalidation_price: wave.invalidationPrice,
        invalidation_condition: wave.invalidationCondition,
        reason: wave.reason,
      }, { conflict: ["run_id", "instrument_id"] });
    if (error) throw error;
  } catch (err) {
    await recordPersistenceError(db, runId, instrument.instrument_id, "fifteen_minute_wave", err);
  }

  let rsiDivergence = { result: "NO_DATA", pricePivot1: null, pricePivot2: null };
  let macdDivergence = { result: "NO_DATA", pricePivot1: null, pricePivot2: null };
  try {
    rsiDivergence = detectRsiBullishDivergence(fifteenMinBars, { rsiPeriod: params.rsiPeriod, pivotLeftWindow: params.pivotLeftWindow, pivotRightWindow: params.pivotRightWindow, lookback: params.divergenceLookback });
    macdDivergence = detectMacdBullishDivergence(fifteenMinBars, { macdFast: params.macdFast, macdSlow: params.macdSlow, macdSignal: params.macdSignal, pivotLeftWindow: params.pivotLeftWindow, pivotRightWindow: params.pivotRightWindow, lookback: params.divergenceLookback });
    for (const [indicatorName, result] of [
      ["rsi", rsiDivergence],
      ["macd_histogram", macdDivergence],
    ]) {
      const { error } = await ops.upsert(db, "buy_setup_divergence_evidence", {
          run_id: runId,
          instrument_id: instrument.instrument_id,
          indicator: indicatorName,
          price_pivot_1_ts: result.pricePivot1?.date ?? null,
          price_pivot_1_value: result.pricePivot1?.price ?? null,
          price_pivot_2_ts: result.pricePivot2?.date ?? null,
          price_pivot_2_value: result.pricePivot2?.price ?? null,
          indicator_pivot_1_value: result.indicatorPivot1Value,
          indicator_pivot_2_value: result.indicatorPivot2Value,
          result: result.result,
          reason: result.reason,
          parameter_version: params.parameterVersion,
        }, { conflict: ["run_id", "instrument_id", "indicator"] });
      if (error) throw error;
    }
  } catch (err) {
    await recordPersistenceError(db, runId, instrument.instrument_id, "divergence", err);
  }

  try {
    const fifteenMinCloses = fifteenMinBars.map((b) => b.close);
    const fifteenMinHighs = fifteenMinBars.map((b) => b.high);
    const fifteenMinLows = fifteenMinBars.map((b) => b.low);
    const hasBars = fifteenMinBars.length > 0;
    const { k: stochKSeries, d: stochDSeries } = hasBars ? stochasticSeries(fifteenMinHighs, fifteenMinLows, fifteenMinCloses, params.stochasticLookback, params.stochasticSmoothing, params.stochasticSmoothing) : { k: [], d: [] };
    const { macdSeries, signalSeries } = hasBars ? macdLineAndSignalSeries(fifteenMinCloses, params.macdFast, params.macdSlow, params.macdSignal) : { macdSeries: [], signalSeries: [] };
    const histogramSeries = hasBars ? macdHistogramSeries(fifteenMinCloses, params.macdFast, params.macdSlow, params.macdSignal) : [];
    const { plusDI, minusDI, adx: adxLine } = hasBars ? adxSeries(fifteenMinHighs, fifteenMinLows, fifteenMinCloses, params.adxDmiPeriod) : { plusDI: [], minusDI: [], adx: [] };
    const { upper, middle, lower } = hasBars ? bollingerBandsSeries(fifteenMinCloses, params.bollingerLookback, params.bollingerDeviation) : { upper: [], middle: [], lower: [] };

    const intradaySvg = renderIntradayChart({
      symbol: instrument.symbol,
      bars: fifteenMinBars,
      ema: hasBars ? { fastPeriod, slowPeriod: slowPeriods[0], fastSeries: emaSeries(fifteenMinCloses, fastPeriod), slowSeries: emaSeries(fifteenMinCloses, slowPeriods[0]) } : null,
      emaCrossover: intradayEmaEvidence ? { status: intradayEmaEvidence.overallStatus, crossoverBarDate: intradayEmaEvidence.perSlowPeriod.find((r) => r.status === "TRIGGERED")?.crossoverBarDate ?? null } : null,
      bollinger: hasBars ? { upperSeries: upper, middleSeries: middle, lowerSeries: lower } : null,
      wave,
      divergences: [
        { indicator: "rsi", result: rsiDivergence.result, pricePivot1: rsiDivergence.pricePivot1, pricePivot2: rsiDivergence.pricePivot2 },
        { indicator: "macd", result: macdDivergence.result, pricePivot1: macdDivergence.pricePivot1, pricePivot2: macdDivergence.pricePivot2 },
      ],
      rsiSeries: hasBars ? rsiSeries(fifteenMinCloses, params.rsiPeriod) : null,
      stochastic: hasBars ? { kSeries: stochKSeries, dSeries: stochDSeries } : null,
      macd: hasBars ? { macdSeries, signalSeries, histogramSeries } : null,
      dmi: hasBars ? { plusDiSeries: plusDI, minusDiSeries: minusDI, adxSeries: adxLine } : null,
    });
    await storeChart(db, chartStore, runId, instrument.instrument_id, "15m", intradaySvg);
  } catch (err) {
    await recordPersistenceError(db, runId, instrument.instrument_id, "intraday_chart", err);
  }
}

async function upsertEmaCrossover(db, runId, instrumentId, timeframe, evidence, params) {
  for (const r of evidence.perSlowPeriod) {
    const { error } = await ops.upsert(db, "buy_setup_ema_crossover", {
        run_id: runId,
        instrument_id: instrumentId,
        timeframe,
        fast_period: r.fastPeriod,
        slow_period: r.slowPeriod,
        fast_value: r.fastValue,
        slow_value: r.slowValue,
        fast_previous: r.fastPrevious,
        slow_previous: r.slowPrevious,
        crossover_bar_ts: r.crossoverBarDate,
        status: r.status,
        confirmation_window: r.confirmationWindow,
        parameter_version: params.parameterVersion,
      }, { conflict: ["run_id", "instrument_id", "timeframe", "slow_period"] });
    if (error) throw error;
  }
}

// ---------------------------------------------------------------------------
// Batch orchestration
// ---------------------------------------------------------------------------

async function loadTimeframeGateResults(db, runId, ruleId) {
  const { data, error } = await ops.select(db, `select instrument_id, result, observed_values from rule_traces
        where run_id = $1
          and rule_id = $2`, [runId, ruleId], "many");
  if (error) throw error;
  const map = new Map();
  const dowKey = ruleId === "BSP-M1" ? "monthly_dow_state" : "weekly_dow_state";
  const breakoutKey = ruleId === "BSP-M1" ? "monthly_range_breakout_up_with_volume" : "weekly_range_breakout_up_with_volume";
  for (const row of data ?? []) {
    map.set(row.instrument_id, { dowState: row.observed_values?.[dowKey] ?? null, breakoutUp: row.observed_values?.[breakoutKey] ?? null });
  }
  return map;
}

/** Once every 'gate' batch is done, creates the 'fifteen_minute' batches from whichever instruments actually passed BSA-G1 -- idempotent (no-ops if they already exist). */
async function ensureFifteenMinuteBatchesSeeded(db, runId) {
  const { count: existing } = await ops.count(db, `select count(*) as n from buy_setup_pipeline_batches
        where run_id = $1 and stage = $2`, [runId, "fifteen_minute"]);
  if ((existing ?? 0) > 0) return; // already seeded by an earlier invocation

  const { count: pendingGate } = await ops.count(db, `select count(*) as n from buy_setup_pipeline_batches
        where run_id = $1 and stage = $2 and status = any($3)`, [runId, "gate", ["pending", "in_progress"]]);
  if ((pendingGate ?? 0) > 0) return; // gate stage not finished yet

  const { data: passed, error } = await ops.select(db, `select instrument_id from buy_setup_gate_traces
        where run_id = $1
          and rule_id = $2
          and result = $3`, [runId, "BSA-G1", "PASS"], "many");
  if (error) throw error;
  const qualifiedIds = (passed ?? []).map((r) => r.instrument_id);
  if (qualifiedIds.length === 0) return; // nothing qualified -- no fifteen_minute batches needed, publish will report 0 qualified

  const chunks = buildChunks(qualifiedIds, FIFTEEN_MINUTE_CHUNK_SIZE);
  const { error: insertError } = await ops.insert(db, "buy_setup_pipeline_batches", chunks.map((chunk) => ({ run_id: runId, stage: "fifteen_minute", cursor: JSON.stringify(chunk), status: "pending" })));
  if (insertError) throw insertError;
}

async function giveUpOnRun(db, runId) {
  await ops.update(db, "buy_setup_manifests", { enrichment_state: "validation_failed", validation_errors: [`Enrichment exceeded its ${Math.round(MAX_TOTAL_RUN_DURATION_MS / 60000)}-minute total duration cap`], validated_at: new Date().toISOString() }, { run_id: runId });
}

async function runEnrichment({ db, chartStore, runId }) {
    try {
    const { data: run, error: runError } = await ops.select(db, `select * from screening_runs
        where id = $1`, [runId], "single");
    if (runError) throw runError;
    if (!run) throw new Error(`screening run ${runId} not found`);
    if (run.publication_state !== "published") {
      throw new Error(`screening run ${runId} is not published (publication_state=${run.publication_state}) -- buy-setup enrichment refuses to run against an unpublished snapshot`);
    }

    const { data: manifest } = await ops.select(db, `select * from buy_setup_manifests
        where run_id = $1`, [runId], "maybe");

    let strategyVersionId;
    let ruleVersion;
    let params;

    if (manifest) {
      // Resuming an already-started enrichment: reuse its PINNED versions
      // verbatim -- never re-resolve "the currently active" version
      // mid-run (this is what makes the pin immutable across a resumed
      // invocation, not just within one).
      strategyVersionId = manifest.strategy_version_id;
      ruleVersion = manifest.rule_version;
      const { data: paramRow, error: paramError } = await ops.select(db, `select * from parameter_versions
        where id = $1`, [manifest.parameter_version_id], "single");
      if (paramError) throw paramError;
      params = resolveBuySetupParameters(paramRow);
      params.ruleVersion = ruleVersion;
    } else {
      // Fresh enrichment: resolve and pin the CURRENTLY active BSA strategy
      // version and parameter version ONCE, here, before any batch exists.
      const { data: activeVersions, error: versionsError } = await ops.select(db, `select * from strategy_versions
        where framework = $1
          and is_active = $2
        order by created_at desc
        limit $3`, ["BSA", true, 1], "many");
      if (versionsError) throw versionsError;
      if (!activeVersions || activeVersions.length === 0) {
        throw new Error("no active BSA strategy_versions found -- has strategies/buy-setup-analysis.yaml been seeded?");
      }
      strategyVersionId = activeVersions[0].id;
      ruleVersion = activeVersions[0].rule_version;

      const { data: paramRows, error: paramError } = await ops.select(db, `select * from parameter_versions
        order by created_at desc
        limit $1`, [1], "many");
      if (paramError) throw paramError;
      if (!paramRows || paramRows.length === 0) throw new Error("no parameter_versions row found -- has config/parameters.yaml been seeded?");
      params = resolveBuySetupParameters(paramRows[0]);
      params.ruleVersion = ruleVersion;

      const { count: expectedEquities } = await ops.count(db, `select count(*) as n from run_universe_instruments
        where run_id = $1 and is_index = $2`, [runId, false]);

      const { error: manifestError } = await ops.insert(db, "buy_setup_manifests", {
        run_id: runId,
        enrichment_state: "processing",
        strategy_version_id: strategyVersionId,
        rule_version: ruleVersion,
        parameter_version_id: params.parameterVersionId,
        parameter_version: params.parameterVersion,
        expected_equity_count: expectedEquities ?? 0,
      });
      if (manifestError) throw manifestError;

      // Detector coverage disclosure -- one row per run.
      await ops.upsert(db, "buy_setup_pattern_detector_coverage", {
          run_id: runId,
          candlestick_implemented: PATTERN_COVERAGE.implemented,
          candlestick_not_evaluated: PATTERN_COVERAGE.notEvaluated,
          chart_pattern_implemented: ["Double Top", "Double Bottom"],
          chart_pattern_not_evaluated: PATTERN_COVERAGE.notEvaluated,
        }, { conflict: ["run_id"] });

      const { data: universe, error: universeError } = await ops.select(db, `select instrument_id from run_universe_instruments
        where run_id = $1
          and is_index = $2`, [runId, false], "many");
      if (universeError) throw universeError;
      const instrumentIds = (universe ?? []).map((r) => r.instrument_id);
      const chunks = buildChunks(instrumentIds, GATE_CHUNK_SIZE);
      const { error: batchError } = await ops.insert(db, "buy_setup_pipeline_batches", chunks.map((chunk) => ({ run_id: runId, stage: "gate", cursor: JSON.stringify(chunk), status: "pending" })));
      if (batchError) throw batchError;
    }
    const { data: manifestRow, error: manifestFetchError } = await ops.select(db, `select computed_at from buy_setup_manifests
        where run_id = $1`, [runId], "single");
    if (manifestFetchError) throw manifestFetchError;
    const enrichmentStartedAtMs = new Date(manifestRow.computed_at).getTime();

    const { data: gateRulesRaw, error: gateRulesError } = await ops.select(db, `select * from rule_definitions
        where strategy_version_id = $1`, [strategyVersionId], "many");
    if (gateRulesError) throw gateRulesError;
    const gateRules = (gateRulesRaw ?? []).map((r) => ({ ...r, inputs: r.inputs ?? [], parameters: r.parameters ?? [] }));

    const [{ data: instrumentRows, error: instError }] = await Promise.all([
      ops.select(db, `select id, symbol from instruments`, [], "many"),
    ]);
    if (instError) throw instError;
    const symbolById = new Map((instrumentRows ?? []).map((i) => [i.id, i.symbol]));

    const [monthlyByInstrument, weeklyByInstrument] = await Promise.all([
      loadTimeframeGateResults(db, runId, "BSP-M1"),
      loadTimeframeGateResults(db, runId, "BSP-M3"),
    ]);

    for (;;) {
      const elapsedTotalMs = Date.now() - enrichmentStartedAtMs;
      const resetBatches = await db.query("select * from reset_stale_buy_setup_batches($1::uuid, $2::integer, $3::integer)", [runId, STALE_BATCH_AFTER_SECONDS, MAX_CHUNK_ATTEMPTS]);
      for (const rb of resetBatches) {
        if (rb.status === "failed") {
          const ids = JSON.parse(rb.cursor ?? "[]");
          for (const id of ids) {
            await recordPersistenceError(db, runId, id, rb.stage === "gate" ? "gate" : "fifteen_minute_bars", new Error(`batch ${rb.id} (${rb.stage}) gave up after ${rb.attempt} stale/stuck attempts`));
          }
        }
      }

      if (elapsedTotalMs > MAX_TOTAL_RUN_DURATION_MS) {
        await giveUpOnRun(db, runId);
        break;
      }

      const claimed = await db.query("select * from claim_next_buy_setup_batch($1::uuid)", [runId]);
      let batch = claimed[0] ?? null;

      if (!batch) {
        await ensureFifteenMinuteBatchesSeeded(db, runId);
        const reclaimed = await db.query("select * from claim_next_buy_setup_batch($1::uuid)", [runId]);
        batch = reclaimed[0] ?? null;
      }

      if (!batch) {
        // Nothing claimable, and seeding didn't produce new work either --
        // check whether anything is still outstanding elsewhere (another
        // invocation could be mid-batch) before concluding the run is done.
        const { data: outstanding } = await ops.select(db, `select id from buy_setup_pipeline_batches
        where run_id = $1
          and status = any($2)
        limit $3`, [runId, ["pending", "in_progress"], 1], "many");
        if (outstanding && outstanding.length > 0) {
          // In flight under a dead execution until its stale reset frees it: wait and
          // re-check (this job holds the lease, so nothing else would resume it).
          await sleep(Number(process.env.BUY_SETUP_POLL_MS ?? 15_000));
          continue;
        }

        await db.query("select publish_buy_setup_enrichment($1::uuid)", [runId]); // validates transactionally; raises on failure
        break;
      }

      await processClaimedBatch(batch);
    }

    async function processClaimedBatch(batch) {
      const instrumentIds = JSON.parse(batch.cursor ?? "[]");
      try {
        await withLeaseHeartbeat(db, runId, async () => {
          if (batch.stage === "gate") {
            await processGateBatch({ db, runId, runDate: run.run_date, instrumentIds, gateRules, params, monthlyByInstrument, weeklyByInstrument });
          } else {
            const instruments = instrumentIds.map((id) => ({ instrument_id: id, symbol: symbolById.get(id) ?? id }));
            await processFifteenMinuteBatch({ db, chartStore, runId, runDate: run.run_date, asOfTimestamp: run.as_of_timestamp, instruments, params });
          }
        });
        await ops.update(db, "buy_setup_pipeline_batches", { status: "done", updated_at: new Date().toISOString() }, { id: batch.id });
      } catch (err) {
        if (err instanceof FyersAuthError) throw err; // abort the run; retrying batches cannot fix an expired token
        const message = errorMessage(err);
        const gaveUp = batch.attempt >= MAX_CHUNK_ATTEMPTS;
        await ops.update(db, "buy_setup_pipeline_batches", { status: gaveUp ? "failed" : "pending", last_error: message, updated_at: new Date().toISOString() }, { id: batch.id });
      }
    }
  } catch (err) {
    await ops
      .update(db, "buy_setup_manifests", { enrichment_state: "validation_failed", validation_errors: [errorMessage(err)], validated_at: new Date().toISOString() }, { run_id: runId })
      .catch(() => {}); // never mask the original failure
    throw err;
  } finally {
    await releaseRunLease(db, RUN_TYPE, runId);
  }
}

/**
 * Runs (or resumes) the enrichment for a published screening run.
 * @param {{ db: import("../db/client.js").Db, chartStore: { putSvg(path: string, svg: string): Promise<void> }, runId: string }} args
 * @returns {Promise<{ runId: string, status: string, note?: string }>}
 */
export async function runBuySetupJob({ db, chartStore, runId }) {
  const existingManifest = await db.one("select enrichment_state from buy_setup_manifests where run_id = $1", [runId]);
  if (existingManifest?.enrichment_state === "published") {
    return { runId, status: "published" };
  }

  const lease = await acquireRunLease(db, RUN_TYPE, runId, { leaseDurationMs: LEASE_DURATION_MS });
  if (!lease.acquired) {
    // Another execution (a previous click or a retry) is already active.
    // Idempotent: never starts a duplicate enrichment.
    return { runId, status: "processing", note: "An enrichment execution is already active for this run." };
  }

  await runEnrichment({ db: db, chartStore, runId });
  const manifest = await db.one("select enrichment_state from buy_setup_manifests where run_id = $1", [runId]);
  return { runId, status: manifest?.enrichment_state ?? "processing" };
}

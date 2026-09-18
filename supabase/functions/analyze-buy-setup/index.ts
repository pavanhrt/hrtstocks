// analyze-buy-setup Edge Function -- the three-timeframe gate + staged
// 15-minute enrichment for the /buy-setup-analysis page
// (strategies/buy-setup-analysis.yaml, PROJECT_DEFAULT/user-requested; see
// that file's decision record).
//
// Invoked by: the Next.js POST /api/buy-setup-analysis route (Researcher+
// only, manual trigger -- same authentication pattern as
// /api/screening-runs), and this function's own self-chain continuation
// request (resume_run_id). All calls use the project's secret key as a
// Bearer token, this function's own auth check below.
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
// continuously via withLeaseHeartbeat while a batch is being processed (the
// same fix this task applied to run-screening's own lease/cron race
// earlier), and a self-chain handoff before this invocation's own
// wall-clock budget runs out. A killed invocation is recoverable: the next
// invocation (self-chained, or a fresh POST) resumes from whatever
// buy_setup_pipeline_batches/buy_setup_manifests state was last persisted --
// every write below is an idempotent upsert or a delete-then-reinsert scoped
// to exactly the row(s) being recomputed, never the whole run's evidence.

import { createClient } from "npm:@supabase/supabase-js@2";
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
import { immutableChartIdentity, isExistingChartObjectError } from "../run-screening/charts/immutable-path.js";
import { buildChunks } from "../run-screening/pipeline/chunks.js";

const RUN_TYPE = "buy_setup_analysis";
const LEASE_DURATION_MS = 3 * 60 * 1000;
const HEARTBEAT_INTERVAL_MS = 45 * 1000;
const TIME_BUDGET_MS = 100_000;
const MAX_TOTAL_RUN_DURATION_MS = 40 * 60 * 1000;
const STALE_BATCH_AFTER_SECONDS = 480;
const MAX_CHUNK_ATTEMPTS = 3;
const INSTRUMENT_CONCURRENCY = 5; // lower than run-screening's 10: each qualified instrument now also does a 15-minute fetch
const GATE_CHUNK_SIZE = 100; // no network I/O per instrument in this stage -- larger chunks than a Fyers-bound one are safe
const FIFTEEN_MINUTE_CHUNK_SIZE = 20; // one Fyers fetch + several DB writes + two chart renders per instrument

const SUPABASE_URL = Deno.env.get("SUPABASE_URL");
const SECRET_KEY = JSON.parse(Deno.env.get("APP_SECRET_KEYS") ?? "{}").default;
const CHART_BUCKET = "direction-charts"; // reuses the existing immutable chart bucket -- same storage policy, same content-addressed convention

function json(body, status = 200) {
  return new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });
}

async function withLeaseHeartbeat(supabase, runId, work) {
  const interval = setInterval(() => {
    heartbeatRunLease(supabase, RUN_TYPE, runId, { leaseDurationMs: LEASE_DURATION_MS }).catch(() => {});
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

// A thrown PostgREST/Supabase error (e.g. from .rpc() or a query builder
// call) is a plain {message, details, hint, code} object, not a JS Error
// instance -- `err instanceof Error ? err.message : String(err)` falls
// through to String() on an object, producing the useless literal string
// "[object Object]" instead of the actual error text. Confirmed live
// (2026-09-15): publish_buy_setup_enrichment's ambiguous-column error was
// recorded as exactly "[object Object]" in validation_errors before this
// fix, hiding the real Postgres error from anyone reading the manifest.
function errorMessage(err) {
  if (err instanceof Error) return err.message;
  if (err && typeof err === "object" && typeof err.message === "string") return err.message;
  return String(err);
}

async function recordPersistenceError(supabase, runId, instrumentId, stage, err) {
  const message = errorMessage(err);
  await supabase.from("buy_setup_persistence_errors").insert({ run_id: runId, instrument_id: instrumentId, stage, error_message: message });
}

async function loadDailyBars(supabase, instrumentId, runDate) {
  const { data, error } = await supabase
    .from("market_bars_raw")
    .select("session_date, open, high, low, close, volume")
    .eq("instrument_id", instrumentId)
    .eq("interval", "1d")
    .eq("provider", "fyers")
    .lte("session_date", runDate)
    .order("session_date", { ascending: true });
  if (error) throw error;
  return (data ?? []).map((b) => ({ date: b.session_date, open: b.open, high: b.high, low: b.low, close: b.close, volume: b.volume }));
}

async function storeChart(supabase, runId, instrumentId, timeframe, svg) {
  const { objectPath, contentHash } = await immutableChartIdentity(instrumentId, `buy-setup-${timeframe}`, svg);
  const { error: uploadError } = await supabase.storage.from(CHART_BUCKET).upload(objectPath, new Blob([svg], { type: "image/svg+xml" }), {
    contentType: "image/svg+xml",
    upsert: false,
  });
  if (uploadError && !isExistingChartObjectError(uploadError)) throw uploadError;
  const { error } = await supabase.from("buy_setup_charts").upsert(
    { run_id: runId, instrument_id: instrumentId, timeframe, chart_object_path: objectPath, chart_content_hash: contentHash, chart_algorithm_version: BUY_SETUP_RENDER_VERSION },
    { onConflict: "run_id,instrument_id,timeframe" }
  );
  if (error) throw error;
}

// ---------------------------------------------------------------------------
// Stage 1: three-timeframe gate, evaluated for the COMPLETE stock universe.
// ---------------------------------------------------------------------------

async function processGateBatch({ supabase, runId, runDate, instrumentIds, gateRules, params, monthlyByInstrument, weeklyByInstrument }) {
  await runWithConcurrencyLimit(instrumentIds, INSTRUMENT_CONCURRENCY, async (instrumentId) => {
    try {
      const dailyBars = await loadDailyBars(supabase, instrumentId, runDate);
      const context = buildThreeTimeframeContext({
        monthlyDowState: monthlyByInstrument.get(instrumentId)?.dowState ?? null,
        monthlyBreakoutUpWithVolume: monthlyByInstrument.get(instrumentId)?.breakoutUp ?? null,
        weeklyDowState: weeklyByInstrument.get(instrumentId)?.dowState ?? null,
        weeklyBreakoutUpWithVolume: weeklyByInstrument.get(instrumentId)?.breakoutUp ?? null,
        dailyBars,
        params: { zigzagDailyPct: params.zigzagDailyPct, volumeLookback: params.volumeLookback, volumeMultiplier: params.volumeMultiplier },
      });
      const { traces } = evaluateThreeTimeframeGate(gateRules, context);

      const { error } = await supabase.from("buy_setup_gate_traces").upsert(
        traces.map((t) => ({
          run_id: runId,
          instrument_id: instrumentId,
          rule_id: t.rule_id,
          rule_version: params.ruleVersion,
          parameter_version: params.parameterVersion,
          observed_values: t.observed_values,
          thresholds: t.thresholds,
          result: t.result,
          explanation: t.explanation,
        })),
        { onConflict: "run_id,instrument_id,rule_id" }
      );
      if (error) throw error;
    } catch (err) {
      await recordPersistenceError(supabase, runId, instrumentId, "gate", err);
    }
  });
}

// ---------------------------------------------------------------------------
// Stage 2: full daily + 15-minute analysis, for gate-qualified instruments only.
// ---------------------------------------------------------------------------

async function processFifteenMinuteBatch({ supabase, runId, runDate, asOfTimestamp, instruments, params }) {
  await runWithConcurrencyLimit(instruments, INSTRUMENT_CONCURRENCY, (instrument) =>
    processQualifiedInstrument({ supabase, runId, runDate, asOfTimestamp, instrument, params })
  );
}

async function processQualifiedInstrument({ supabase, runId, runDate, asOfTimestamp, instrument, params }) {
  const dailyBars = await loadDailyBars(supabase, instrument.instrument_id, runDate);
  const { fastPeriod, slowPeriods } = emaCrossoverPeriods(params);

  // ---- Daily candlestick vs. chart patterns -- two separate detector
  // families, persisted into two separate tables, never merged. Multiple
  // detections per instrument are all persisted (not just the first).
  try {
    const candlestickHits = detectCandlestickPatterns(dailyBars);
    const { error } = await supabase.from("buy_setup_candlestick_detections").delete().eq("run_id", runId).eq("instrument_id", instrument.instrument_id);
    if (error) throw error;
    if (candlestickHits.length > 0) {
      const { error: insertError } = await supabase.from("buy_setup_candlestick_detections").insert(
        candlestickHits.map((h) => ({
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
        }))
      );
      if (insertError) throw insertError;
    }
  } catch (err) {
    await recordPersistenceError(supabase, runId, instrument.instrument_id, "daily_patterns", err);
  }

  try {
    const chartPatternHits = detectDoubleExtremePatterns(zigzagPivots(dailyBars, params.zigzagDailyPct), dailyBars);
    const { error } = await supabase.from("buy_setup_chart_pattern_detections").delete().eq("run_id", runId).eq("instrument_id", instrument.instrument_id);
    if (error) throw error;
    if (chartPatternHits.length > 0) {
      const { error: insertError } = await supabase.from("buy_setup_chart_pattern_detections").insert(
        chartPatternHits.map((h) => ({
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
        }))
      );
      if (insertError) throw insertError;
    }
  } catch (err) {
    await recordPersistenceError(supabase, runId, instrument.instrument_id, "daily_patterns", err);
  }

  let dailyEmaEvidence = null;
  try {
    dailyEmaEvidence = detectPositiveEmaCrossoverEvidence(dailyBars, { fastPeriod, slowPeriods, confirmationWindow: params.emaCrossoverConfirmationWindow });
    await upsertEmaCrossover(supabase, runId, instrument.instrument_id, "daily", dailyEmaEvidence, params);
  } catch (err) {
    await recordPersistenceError(supabase, runId, instrument.instrument_id, "daily_ema", err);
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
    const { error: levelsError } = await supabase.from("buy_setup_chart_levels").upsert(
      {
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
      },
      { onConflict: "run_id,instrument_id" }
    );
    if (levelsError) throw levelsError;
  } catch (err) {
    await recordPersistenceError(supabase, runId, instrument.instrument_id, "chart_levels", err);
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
    await storeChart(supabase, runId, instrument.instrument_id, "daily", dailySvg);
  } catch (err) {
    await recordPersistenceError(supabase, runId, instrument.instrument_id, "daily_chart", err);
  }

  // ---- 15-minute analysis ----
  let fifteenMinBars = [];
  try {
    const raw = await fetchFifteenMinuteOHLCV(instrument.instrument_id, instrument.symbol, supabase, { asOfTimestamp });
    fifteenMinBars = normalizeCompletedFifteenMinuteBars(raw.data, asOfTimestamp);
    if (fifteenMinBars.length > 0) {
      const { error: barsError } = await supabase.from("buy_setup_fifteen_minute_bars").upsert(
        fifteenMinBars.map((b) => ({
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
        })),
        { onConflict: "run_id,instrument_id,ts" }
      );
      if (barsError) throw barsError;
    }
  } catch (err) {
    await recordPersistenceError(supabase, runId, instrument.instrument_id, "fifteen_minute_bars", err);
  }

  let intradayEmaEvidence = null;
  try {
    intradayEmaEvidence = detectPositiveEmaCrossoverEvidence(fifteenMinBars, { fastPeriod, slowPeriods, confirmationWindow: params.emaCrossoverConfirmationWindow });
    await upsertEmaCrossover(supabase, runId, instrument.instrument_id, "15m", intradayEmaEvidence, params);
  } catch (err) {
    await recordPersistenceError(supabase, runId, instrument.instrument_id, "intraday_indicators", err);
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
    const { error: indicatorsError } = await supabase.from("buy_setup_intraday_indicators").upsert(
      {
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
      },
      { onConflict: "run_id,instrument_id" }
    );
    if (indicatorsError) throw indicatorsError;
  } catch (err) {
    await recordPersistenceError(supabase, runId, instrument.instrument_id, "intraday_indicators", err);
  }

  let wave = null;
  try {
    wave = computeFifteenMinuteWave(fifteenMinBars, params.zigzagFifteenMinutePct);
    const { error } = await supabase.from("buy_setup_fifteen_minute_wave").upsert(
      {
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
      },
      { onConflict: "run_id,instrument_id" }
    );
    if (error) throw error;
  } catch (err) {
    await recordPersistenceError(supabase, runId, instrument.instrument_id, "fifteen_minute_wave", err);
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
      const { error } = await supabase.from("buy_setup_divergence_evidence").upsert(
        {
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
        },
        { onConflict: "run_id,instrument_id,indicator" }
      );
      if (error) throw error;
    }
  } catch (err) {
    await recordPersistenceError(supabase, runId, instrument.instrument_id, "divergence", err);
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
    await storeChart(supabase, runId, instrument.instrument_id, "15m", intradaySvg);
  } catch (err) {
    await recordPersistenceError(supabase, runId, instrument.instrument_id, "intraday_chart", err);
  }
}

async function upsertEmaCrossover(supabase, runId, instrumentId, timeframe, evidence, params) {
  for (const r of evidence.perSlowPeriod) {
    const { error } = await supabase.from("buy_setup_ema_crossover").upsert(
      {
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
      },
      { onConflict: "run_id,instrument_id,timeframe,slow_period" }
    );
    if (error) throw error;
  }
}

// ---------------------------------------------------------------------------
// Batch orchestration
// ---------------------------------------------------------------------------

async function loadTimeframeGateResults(supabase, runId, ruleId) {
  const { data, error } = await supabase.from("rule_traces").select("instrument_id, result, observed_values").eq("run_id", runId).eq("rule_id", ruleId);
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
async function ensureFifteenMinuteBatchesSeeded(supabase, runId) {
  const { count: existing } = await supabase.from("buy_setup_pipeline_batches").select("id", { count: "exact", head: true }).eq("run_id", runId).eq("stage", "fifteen_minute");
  if ((existing ?? 0) > 0) return; // already seeded by an earlier invocation

  const { count: pendingGate } = await supabase
    .from("buy_setup_pipeline_batches")
    .select("id", { count: "exact", head: true })
    .eq("run_id", runId)
    .eq("stage", "gate")
    .in("status", ["pending", "in_progress"]);
  if ((pendingGate ?? 0) > 0) return; // gate stage not finished yet

  const { data: passed, error } = await supabase.from("buy_setup_gate_traces").select("instrument_id").eq("run_id", runId).eq("rule_id", "BSA-G1").eq("result", "PASS");
  if (error) throw error;
  const qualifiedIds = (passed ?? []).map((r) => r.instrument_id);
  if (qualifiedIds.length === 0) return; // nothing qualified -- no fifteen_minute batches needed, publish will report 0 qualified

  const chunks = buildChunks(qualifiedIds, FIFTEEN_MINUTE_CHUNK_SIZE);
  const { error: insertError } = await supabase.from("buy_setup_pipeline_batches").insert(chunks.map((chunk) => ({ run_id: runId, stage: "fifteen_minute", cursor: JSON.stringify(chunk), status: "pending" })));
  if (insertError) throw insertError;
}

async function giveUpOnRun(supabase, runId) {
  await supabase
    .from("buy_setup_manifests")
    .update({ enrichment_state: "validation_failed", validation_errors: [`Enrichment exceeded its ${Math.round(MAX_TOTAL_RUN_DURATION_MS / 60000)}-minute total duration cap`], validated_at: new Date().toISOString() })
    .eq("run_id", runId);
}

async function runEnrichment({ supabase, runId, invocationStartedAtMs }) {
  let releasedForHandoff = false;
  try {
    const { data: run, error: runError } = await supabase.from("screening_runs").select("*").eq("id", runId).single();
    if (runError) throw runError;
    if (!run) throw new Error(`screening run ${runId} not found`);
    if (run.publication_state !== "published") {
      throw new Error(`screening run ${runId} is not published (publication_state=${run.publication_state}) -- buy-setup enrichment refuses to run against an unpublished snapshot`);
    }

    const { data: manifest } = await supabase.from("buy_setup_manifests").select("*").eq("run_id", runId).maybeSingle();

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
      const { data: paramRow, error: paramError } = await supabase.from("parameter_versions").select("*").eq("id", manifest.parameter_version_id).single();
      if (paramError) throw paramError;
      params = resolveBuySetupParameters(paramRow);
      params.ruleVersion = ruleVersion;
    } else {
      // Fresh enrichment: resolve and pin the CURRENTLY active BSA strategy
      // version and parameter version ONCE, here, before any batch exists.
      const { data: activeVersions, error: versionsError } = await supabase.from("strategy_versions").select("*").eq("framework", "BSA").eq("is_active", true).order("created_at", { ascending: false }).limit(1);
      if (versionsError) throw versionsError;
      if (!activeVersions || activeVersions.length === 0) {
        throw new Error("no active BSA strategy_versions found -- has strategies/buy-setup-analysis.yaml been seeded?");
      }
      strategyVersionId = activeVersions[0].id;
      ruleVersion = activeVersions[0].rule_version;

      const { data: paramRows, error: paramError } = await supabase.from("parameter_versions").select("*").order("created_at", { ascending: false }).limit(1);
      if (paramError) throw paramError;
      if (!paramRows || paramRows.length === 0) throw new Error("no parameter_versions row found -- has config/parameters.yaml been seeded?");
      params = resolveBuySetupParameters(paramRows[0]);
      params.ruleVersion = ruleVersion;

      const { count: expectedEquities } = await supabase.from("run_universe_instruments").select("instrument_id", { count: "exact", head: true }).eq("run_id", runId).eq("is_index", false);

      const { error: manifestError } = await supabase.from("buy_setup_manifests").insert({
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
      await supabase.from("buy_setup_pattern_detector_coverage").upsert(
        {
          run_id: runId,
          candlestick_implemented: PATTERN_COVERAGE.implemented,
          candlestick_not_evaluated: PATTERN_COVERAGE.notEvaluated,
          chart_pattern_implemented: ["Double Top", "Double Bottom"],
          chart_pattern_not_evaluated: PATTERN_COVERAGE.notEvaluated,
        },
        { onConflict: "run_id" }
      );

      const { data: universe, error: universeError } = await supabase.from("run_universe_instruments").select("instrument_id").eq("run_id", runId).eq("is_index", false);
      if (universeError) throw universeError;
      const instrumentIds = (universe ?? []).map((r) => r.instrument_id);
      const chunks = buildChunks(instrumentIds, GATE_CHUNK_SIZE);
      const { error: batchError } = await supabase.from("buy_setup_pipeline_batches").insert(chunks.map((chunk) => ({ run_id: runId, stage: "gate", cursor: JSON.stringify(chunk), status: "pending" })));
      if (batchError) throw batchError;
    }
    const { data: manifestRow, error: manifestFetchError } = await supabase.from("buy_setup_manifests").select("computed_at").eq("run_id", runId).single();
    if (manifestFetchError) throw manifestFetchError;
    const enrichmentStartedAtMs = new Date(manifestRow.computed_at).getTime();

    const { data: gateRulesRaw, error: gateRulesError } = await supabase.from("rule_definitions").select("*").eq("strategy_version_id", strategyVersionId);
    if (gateRulesError) throw gateRulesError;
    const gateRules = (gateRulesRaw ?? []).map((r) => ({ ...r, inputs: r.inputs ?? [], parameters: r.parameters ?? [] }));

    const [{ data: instrumentRows, error: instError }] = await Promise.all([
      supabase.from("instruments").select("id, symbol"),
    ]);
    if (instError) throw instError;
    const symbolById = new Map((instrumentRows ?? []).map((i) => [i.id, i.symbol]));

    const [monthlyByInstrument, weeklyByInstrument] = await Promise.all([
      loadTimeframeGateResults(supabase, runId, "BSP-M1"),
      loadTimeframeGateResults(supabase, runId, "BSP-M3"),
    ]);

    for (;;) {
      const elapsedTotalMs = Date.now() - enrichmentStartedAtMs;
      const { data: resetBatches } = await supabase.rpc("reset_stale_buy_setup_batches", { p_run_id: runId, p_stale_after_seconds: STALE_BATCH_AFTER_SECONDS, p_max_attempts: MAX_CHUNK_ATTEMPTS });
      for (const rb of resetBatches ?? []) {
        if (rb.status === "failed") {
          const ids = JSON.parse(rb.cursor ?? "[]");
          for (const id of ids) {
            await recordPersistenceError(supabase, runId, id, rb.stage === "gate" ? "gate" : "fifteen_minute_bars", new Error(`batch ${rb.id} (${rb.stage}) gave up after ${rb.attempt} stale/stuck attempts`));
          }
        }
      }

      if (elapsedTotalMs > MAX_TOTAL_RUN_DURATION_MS) {
        await giveUpOnRun(supabase, runId);
        break;
      }

      const { data: claimed } = await supabase.rpc("claim_next_buy_setup_batch", { p_run_id: runId });
      let batch = claimed?.[0] ?? null;

      if (!batch) {
        await ensureFifteenMinuteBatchesSeeded(supabase, runId);
        const { data: reclaimed } = await supabase.rpc("claim_next_buy_setup_batch", { p_run_id: runId });
        batch = reclaimed?.[0] ?? null;
      }

      if (!batch) {
        // Nothing claimable, and seeding didn't produce new work either --
        // check whether anything is still outstanding elsewhere (another
        // invocation could be mid-batch) before concluding the run is done.
        const { data: outstanding } = await supabase.from("buy_setup_pipeline_batches").select("id").eq("run_id", runId).in("status", ["pending", "in_progress"]).limit(1);
        if (outstanding && outstanding.length > 0) break; // yield -- another invocation (or a later tick) will pick it up

        const publishResult = await supabase.rpc("publish_buy_setup_enrichment", { p_run_id: runId });
        if (publishResult.error) throw publishResult.error;
        break;
      }

      await processClaimedBatch(batch);

      if (Date.now() - invocationStartedAtMs > TIME_BUDGET_MS) {
        await releaseRunLease(supabase, RUN_TYPE, runId);
        releasedForHandoff = true;
        await selfChain(runId);
        return;
      }
    }

    async function processClaimedBatch(batch) {
      const instrumentIds = JSON.parse(batch.cursor ?? "[]");
      try {
        await withLeaseHeartbeat(supabase, runId, async () => {
          if (batch.stage === "gate") {
            await processGateBatch({ supabase, runId, runDate: run.run_date, instrumentIds, gateRules, params, monthlyByInstrument, weeklyByInstrument });
          } else {
            const instruments = instrumentIds.map((id) => ({ instrument_id: id, symbol: symbolById.get(id) ?? id }));
            await processFifteenMinuteBatch({ supabase, runId, runDate: run.run_date, asOfTimestamp: run.as_of_timestamp, instruments, params });
          }
        });
        await supabase.from("buy_setup_pipeline_batches").update({ status: "done", updated_at: new Date().toISOString() }).eq("id", batch.id);
      } catch (err) {
        const message = errorMessage(err);
        const gaveUp = batch.attempt >= MAX_CHUNK_ATTEMPTS;
        await supabase.from("buy_setup_pipeline_batches").update({ status: gaveUp ? "failed" : "pending", last_error: message, updated_at: new Date().toISOString() }).eq("id", batch.id);
      }
    }
  } catch (err) {
    await supabase
      .from("buy_setup_manifests")
      .update({ enrichment_state: "validation_failed", validation_errors: [errorMessage(err)], validated_at: new Date().toISOString() })
      .eq("run_id", runId)
      .then(() => {});
    throw err;
  } finally {
    if (!releasedForHandoff) await releaseRunLease(supabase, RUN_TYPE, runId);
  }
}

async function selfChain(runId) {
  try {
    await fetch(`${SUPABASE_URL}/functions/v1/analyze-buy-setup`, {
      method: "POST",
      headers: { Authorization: `Bearer ${SECRET_KEY}`, "Content-Type": "application/json" },
      body: JSON.stringify({ run_id: runId }),
    });
  } catch {
    // Best-effort -- if this never lands, the run simply stays 'processing'
    // until a fresh POST (e.g. a Researcher clicking "Run buy-setup
    // analysis" again) resumes it from persisted batch state.
  }
}

Deno.serve(async (req) => {
  const authHeader = req.headers.get("Authorization") ?? "";
  if (authHeader !== `Bearer ${SECRET_KEY}`) return json({ error: "Unauthorized" }, 401);

  const body = await req.json().catch(() => ({}));
  const runId = body.run_id;
  if (!runId) return json({ error: "run_id is required" }, 400);

  const supabase = createClient(SUPABASE_URL, SECRET_KEY);

  const { data: existingManifest } = await supabase.from("buy_setup_manifests").select("enrichment_state").eq("run_id", runId).maybeSingle();
  if (existingManifest?.enrichment_state === "published") {
    return json({ runId, status: "published" });
  }

  const lease = await acquireRunLease(supabase, RUN_TYPE, runId, { leaseDurationMs: LEASE_DURATION_MS });
  if (!lease.acquired) {
    // Another invocation (a previous click, the self-chain, or a
    // recovery-sweep tick) is already active. Idempotent: never starts a
    // duplicate enrichment.
    return json({ runId, status: "processing", note: "An enrichment invocation is already active for this run." });
  }

  const invocationStartedAtMs = Date.now();
  const enrichment = runEnrichment({ supabase, runId, invocationStartedAtMs });
  if (typeof EdgeRuntime !== "undefined") {
    EdgeRuntime.waitUntil(enrichment);
  } else {
    await enrichment;
  }

  return json({ runId, status: "processing" });
});

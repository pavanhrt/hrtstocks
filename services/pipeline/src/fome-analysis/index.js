// FOME single-instrument, on-demand analysis (Cloud Run Job).
// Deliberately NOT the full-universe run-screening pipeline, and NOT built on top
// of buy-setup's manifest/pipeline-batch design (that system is hard-coupled to
// an already-published screening_runs universe -- see fome_analysis_runs' own
// migration comment for why that is the wrong foundation for an ad hoc
// single-instrument request). This analyzes exactly the one instrument named by
// the run row, refreshes only that instrument's data, and completes in one job
// execution -- a handful of sequential Fyers calls (a bounded number of 366-day
// daily-history legs, one 15-minute fetch, one futures-chain, one option-chain,
// one depth call).
//
// Started by: the web app's POST /api/fome-analysis, which creates the
// fome_analysis_runs row (status "queued") and launches this job with
// FOME_RUN_ID (see ../jobs/fome.mjs). The page polls GET /api/fome-analysis/{runId}
// for staged progress and the final result. News retrieval (stage 7 of the
// page's 10-step progress) is intentionally NOT done here: the news
// infrastructure (app/src/lib/news/rss.ts) lives in the Node web app -- the GET
// route appends news once this run reaches a terminal technical status.

import { insertMany, updateWhere, upsertMany } from "../db/write.js";
import { FyersAuthError } from "../run-screening/providers/fyers-credentials.js";
import { safeErrorMessage, safeErrorStack } from "../security/redact.js";
import { fetchOHLCVRange, fetchFifteenMinuteOHLCV, nextIncrementalRange, toFyersSymbol } from "../run-screening/providers/fyers.js";
import { fetchOptionChain, fetchFuturesChain, fetchMarketDepth } from "../run-screening/providers/fyers-derivatives.js";
import { validateBars } from "../run-screening/quality.js";
import { aggregateBars } from "../run-screening/features/structure.js";
import { normalizeCompletedFifteenMinuteBars } from "../run-screening/buy-setup/fifteen-minute-bars.js";
import {
  buildFomeTimeframeRow,
  computeFomeAlignment,
  computeFomeTimeframeInputHash,
  FOME_TIMEFRAME_RESPONSIBILITY_VERSION,
  FOME_ALIGNMENT_LOGIC_VERSION,
} from "../run-screening/fome/timeframe-direction.js";
import { buildFomeRuleContext, FOME_CONTEXT_VERSION } from "../run-screening/fome/rule-context.js";
import { extractProvisionalFifteenMinuteCandle } from "../run-screening/fome/provisional-candle.js";
import { selectNearestExpiry, selectStrikeLadder, checkSpotDerivativeAlignment, hasLiveQuote, CONTRACT_SELECTION_VERSION } from "../run-screening/fome/contract-selection.js";
import { evaluateRules } from "../run-screening/rules/evaluate.js";
import {
  compareStrategies,
  bullCallSpread,
  bearPutSpread,
  bullPutSpread,
  bearCallSpread,
  longCall,
  longPut,
  longFutures,
  shortFutures,
  coveredCall,
  coveredPut,
  longCollar,
  shortCollar,
  bullishCallRatioSpread,
  bearishPutRatioSpread,
  longStraddle,
  longStrangle,
  shortIronButterfly,
  shortIronCondor,
  longIronButterfly,
  longIronCondor,
  calendarSpread,
  FOME_STRATEGY_ENGINE_VERSION,
} from "../run-screening/fome/strategy-comparison.js";
import { renderFomeChart, FOME_RENDER_VERSION } from "../run-screening/charts/render-fome.js";
import { immutableChartIdentity } from "../run-screening/charts/immutable-path.js";
import { latestCompletedNseSession } from "../run-screening/nse-calendar.js";

// PROJECT_DEFAULT, versioned here: no FOME source document specifies a
// warm-up window for Monthly MACD. Sanity-checked against run-screening's
// own multi-year backfill precedent for the same underlying requirement (a
// Monthly MACD needs ~35 completed months of history).
const DAILY_HISTORY_TARGET_DAYS = 5 * 365;
const DAILY_HISTORY_LEG_DAYS = 366; // Fyers' own single-request cap for daily-resolution history
const ADJUSTMENT_VERSION = "1.0.0";
const STRIKE_COUNT = 10; // ATM +/- 10 strikes each side -- enough to cover every spread/condor/butterfly width this engine builds

const STAGES = [
  "resolving_instrument",
  "checking_cached_data",
  "refreshing_daily_data",
  "refreshing_15m_data",
  "building_timeframes",
  "retrieving_derivative_information",
  // "retrieving_news" is set by the Next.js GET route, not here -- see header comment.
  "applying_fome_rules",
  "comparing_strategies",
  "saving_and_presenting_result",
];

/**
 * Runs the analysis for an existing fome_analysis_runs row (created by the web app).
 * @param {{ db: import("../db/client.js").Db, chartStore: { putSvg(path: string, svg: string): Promise<void> }, runId: string }} args
 * @returns {Promise<{ runId: string, status: string }>}
 */
export async function runFomeJob({ db, chartStore, runId }) {
  const run = await db.one("select id, instrument_id, status, as_of_timestamp from fome_analysis_runs where id = $1", [runId]);
  if (!run) throw new Error(`fome_analysis_runs row ${runId} does not exist`);
  if (run.status === "completed" || run.status === "partial" || run.status === "failed") {
    return { runId, status: run.status }; // idempotent: never re-run a finished analysis
  }

  const instrument = await db.one("select * from instruments where id = $1", [run.instrument_id]);
  if (!instrument) {
    await updateWhere(db, "fome_analysis_runs", { status: "failed", error_message: `Unknown instrument "${run.instrument_id}"`, completed_at: new Date().toISOString() }, { id: runId });
    return { runId, status: "failed" };
  }

  // FOME is live/on-demand, not tied to a fixed EOD boundary: freeze "now" once
  // and pass it through every fetch below.
  const asOfTimestamp = new Date();
  await updateWhere(
    db,
    "fome_analysis_runs",
    {
      status: "running",
      as_of_timestamp: asOfTimestamp.toISOString(),
      algorithm_version: `timeframes:${FOME_TIMEFRAME_RESPONSIBILITY_VERSION};alignment:${FOME_ALIGNMENT_LOGIC_VERSION};context:${FOME_CONTEXT_VERSION};contracts:${CONTRACT_SELECTION_VERSION}`,
      strategy_engine_version: FOME_STRATEGY_ENGINE_VERSION,
      chart_render_version: FOME_RENDER_VERSION,
      providers: { ohlcv: "fyers", derivatives: "fyers" },
      started_at: new Date().toISOString(),
    },
    { id: runId },
  );

  await runFomeAnalysis({ db, chartStore, runId, instrument, asOfTimestamp });
  const finished = await db.one("select status from fome_analysis_runs where id = $1", [runId]);
  return { runId, status: finished?.status ?? "unknown" };
}

async function setStage(db, runId, stage) {
  // Append atomically so concurrent writers cannot lose a history entry.
  await db.query(
    `update fome_analysis_runs
        set current_stage = $2, stage_history = stage_history || jsonb_build_array(jsonb_build_object('stage', $2::text, 'at', $3::text))
      where id = $1`,
    [runId, stage, new Date().toISOString()],
  );
}

async function runFomeAnalysis({ db, chartStore, runId, instrument, asOfTimestamp }) {
  try {
    await setStage(db, runId, "checking_cached_data");
    const runDate = latestCompletedNseSession(asOfTimestamp);
    const dailyBars = await ensureDailyHistory(db, instrument, runDate);

    const dailyValidation = validateBars(dailyBars, { asOfTimestamp: asOfTimestamp.toISOString() });
    if (dailyValidation.result === "NO_DATA" || dailyValidation.result === "INVALID") {
      await finalizeRun(db, runId, {
        status: "partial",
        dataQuality: dailyValidation.result,
        finalAlignment: "UNAVAILABLE",
        alignmentReason: `Daily bars are ${dailyValidation.result.toLowerCase()}: ${dailyValidation.issues.join("; ") || "no bars available"}.`,
      });
      return;
    }

    await setStage(db, runId, "refreshing_15m_data");
    const { rawFifteenMin, closeConfirmedFifteenMin, provisionalCandle } = await fetchFifteenMinuteEvidence(db, instrument, asOfTimestamp, runId);

    await setStage(db, runId, "building_timeframes");
    const parameterVersionRow = await db.one("select * from parameter_versions order by created_at desc limit 1");
    const documentedParams = parameterVersionRow?.values?.documented ?? {};
    const parameterVersion = parameterVersionRow?.version ?? null;

    const weeklyBars = aggregateBars(dailyBars, "weekly");
    const monthlyBars = aggregateBars(dailyBars, "monthly");

    const monthlyRow = await buildOrReuseTimeframeRow(db, {
      instrumentId: instrument.id,
      timeframe: "monthly",
      timeframeBars: monthlyBars,
      documentedParams,
      parameterVersion,
      currentRunId: runId,
    });
    const weeklyRow = await buildOrReuseTimeframeRow(db, {
      instrumentId: instrument.id,
      timeframe: "weekly",
      timeframeBars: weeklyBars,
      documentedParams,
      parameterVersion,
      currentRunId: runId,
    });
    // Daily is always recomputed fresh -- this project's "actionable setup"
    // timeframe is never served stale, per the cache-policy instruction that
    // only Monthly/Weekly may be reused.
    const dailyRow = buildFomeTimeframeRow("daily", dailyBars, documentedParams, { freshness: "EOD" });
    await persistTimeframeRow(db, runId, dailyRow);

    const fifteenMinRow = buildFomeTimeframeRow("15m", closeConfirmedFifteenMin, documentedParams, {
      freshness: "INTRADAY",
      isProvisional: closeConfirmedFifteenMin.length === 0 && rawFifteenMin.length > 0,
    });
    if (provisionalCandle) {
      fifteenMinRow.isProvisional = true;
      fifteenMinRow.explanation += " The latest 15-minute candle is still forming and is excluded from this structure read.";
    }
    await persistTimeframeRow(db, runId, fifteenMinRow);

    const alignment = computeFomeAlignment({ monthly: monthlyRow, weekly: weeklyRow, daily: dailyRow, fifteenMin: fifteenMinRow });

    await setStage(db, runId, "retrieving_derivative_information");
    const spot = dailyBars.at(-1)?.close ?? null;
    const derivative = await retrieveDerivativeData(db, instrument, spot, asOfTimestamp);

    await renderAndStoreCharts(db, chartStore, runId, instrument, {
      dailyBars,
      dailyRow,
      closeConfirmedFifteenMin,
      provisionalCandle,
      fifteenMinRow,
    });

    await setStage(db, runId, "applying_fome_rules");
    const ruleContext = buildFomeRuleContext({
      dailyBars,
      dailyRow,
      documentedParams,
      derivative: derivative.ruleInputs,
    });
    ruleContext.__dataSource = "fyers";

    const strategyVersions = await db.query(
      `select id, strategy_id, rule_version from strategy_versions
        where is_active = true and strategy_id = any($1::text[])`,
      [["fome-original", "fome-single-instrument"]],
    );
    const strategyVersionIds = strategyVersions.map((v) => v.id);
    const ruleVersions = strategyVersions.map((v) => v.rule_version).join(",");

    if (strategyVersionIds.length > 0) {
      const ruleDefinitions = await db.query("select * from rule_definitions where strategy_version_id = any($1::uuid[])", [strategyVersionIds]);
      const { traces } = evaluateRules(ruleDefinitions, ruleContext, documentedParams);
      const enrichedTraces = traces.map((t) => {
        const def = ruleDefinitions.find((d) => d.rule_id === t.rule_id);
        return { ...t, timeframe: def?.timeframe ?? "daily", source_status: def?.source_status ?? null };
      });
      if (enrichedTraces.length > 0) {
        await insertMany(
          db,
          "fome_rule_traces",
          enrichedTraces.map((t) => ({
            analysis_run_id: runId,
            rule_id: t.rule_id,
            rule_version: t.rule_version,
            parameter_version: parameterVersion,
            timeframe: t.timeframe,
            observed_values: t.observed_values,
            thresholds: t.thresholds,
            result: t.result,
            source_status: t.source_status,
            data_source: t.data_source,
            source_document: t.source_document,
            source_locator: t.source_locator,
            explanation: t.explanation,
          }))
        );
      }
    }

    await setStage(db, runId, "comparing_strategies");
    const regime = deriveRegime(alignment, dailyRow);
    const candidates = regime
      ? buildStrategyComparison(regime, { spot, derivative, dailyRow })
      : { regime: null, candidates: [], bestFit: null, reason: "No regime could be determined from the current alignment/momentum evidence." };

    if (candidates.candidates.length > 0) {
      await insertMany(
        db,
        "fome_strategy_candidates",
        candidates.candidates.map((c) => ({
          analysis_run_id: runId,
          rank: c.rank,
          strategy_id: c.strategyId,
          qualification_status: c.qualificationStatus,
          why_fits: c.qualificationStatus === "qualified" ? candidates.reason : null,
          why_fails: c.qualificationStatus !== "qualified" ? (c.dataQualityReason ?? "Did not rank as the top defined-risk candidate for this regime.") : null,
          legs: c.legs ?? [],
          lot_size: derivative.lotSize,
          net_debit_or_credit: c.netDebitOrCredit ?? null,
          break_evens: c.breakEvens ?? [],
          max_profit: c.maxProfit ?? null,
          max_loss: c.maxLoss ?? null,
          margin_state: c.margin?.state ?? "unavailable",
          margin: c.margin?.value ?? null,
          reward_risk: c.rewardRisk ?? null,
          unlimited_risk: Boolean(c.unlimitedRisk),
          roi_pct: c.roiPct ?? null,
          data_quality: c.dataQuality ?? (derivative.eligible ? "PASS" : "NO_DATA"),
          final_classification: c.dataQuality === "NO_DATA" ? "NO_DATA" : c.qualificationStatus,
        }))
      );
    }

    await finalizeRun(db, runId, {
      status: "completed",
      dataQuality: dailyValidation.result,
      finalAlignment: alignment.finalAlignment,
      alignmentReason: alignment.reason,
      underlyingAlignment: alignment.underlyingAlignment ?? null,
      derivativeEligible: derivative.eligible,
      derivativeSource: derivative.eligible ? "fyers" : null,
      selectedExpiry: derivative.selectedExpiry,
      selectedExpiryEpoch: derivative.selectedExpiryEpoch,
      spotDerivativeAligned: derivative.spotDerivativeAligned,
      spotDerivativeSkewReason: derivative.spotDerivativeSkewReason,
      ruleVersion: ruleVersions || null,
      parameterVersion,
    });
  } catch (err) {
    // An expired FYERS token gets a clear, actionable message (never the stack).
    const message = err instanceof FyersAuthError ? err.message : safeErrorStack(err);
    await updateWhere(db, "fome_analysis_runs", { status: "failed", error_message: message.slice(0, 4000), completed_at: new Date().toISOString() }, { id: runId });
  }
}

/**
 * Ensures the instrument's daily bar history covers DAILY_HISTORY_TARGET_DAYS
 * (for Monthly MACD warm-up) and is current through `runDate`, fetching only
 * what's actually missing -- an incremental forward fetch via
 * nextIncrementalRange (same primitive run-screening's own daily ingestion
 * uses), plus a one-time backward backfill in DAILY_HISTORY_LEG_DAYS-sized
 * legs only when this instrument has no stored history yet at all.
 */
async function ensureDailyHistory(db, instrument, runDate) {
  const existingRange = await db.query(
    `select session_date from market_bars_raw where instrument_id = $1 and interval = '1d' order by session_date asc`,
    [instrument.id],
  );

  if (existingRange.length === 0) {
    let legEnd = new Date(`${runDate}T00:00:00Z`);
    const targetStart = new Date(legEnd.getTime() - DAILY_HISTORY_TARGET_DAYS * 24 * 60 * 60 * 1000);
    while (legEnd.getTime() > targetStart.getTime()) {
      const legStart = new Date(Math.max(targetStart.getTime(), legEnd.getTime() - DAILY_HISTORY_LEG_DAYS * 24 * 60 * 60 * 1000));
      const { data } = await fetchOHLCVRange(instrument.id, instrument.symbol, legStart, legEnd, db);
      await writeDailyBars(db, instrument.id, data);
      legEnd = new Date(legStart.getTime() - 24 * 60 * 60 * 1000);
    }
  } else {
    const latestStoredSessionDate = existingRange[existingRange.length - 1].session_date;
    const range = nextIncrementalRange(latestStoredSessionDate, runDate, DAILY_HISTORY_TARGET_DAYS);
    if (range) {
      const { data } = await fetchOHLCVRange(instrument.id, instrument.symbol, range.from, range.to, db);
      await writeDailyBars(db, instrument.id, data);
    }
  }

  const windowStart = new Date(new Date(`${runDate}T00:00:00Z`).getTime() - DAILY_HISTORY_TARGET_DAYS * 24 * 60 * 60 * 1000)
    .toISOString()
    .slice(0, 10);
  const storedBars = await db.query(
    `select session_date, open, high, low, close, volume from market_bars_raw
      where instrument_id = $1 and interval = '1d' and session_date >= $2 and session_date <= $3
      order by session_date asc`,
    [instrument.id, windowStart, runDate],
  );

  return storedBars.map((b) => ({ date: b.session_date, open: b.open, high: b.high, low: b.low, close: b.close, volume: b.volume }));
}

async function writeDailyBars(db, instrumentId, bars) {
  if (!bars || bars.length === 0) return;
  await upsertMany(
    db,
    "market_bars_raw",
    bars.map((b) => ({
      instrument_id: instrumentId,
      interval: "1d",
      session_date: b.date,
      ts: `${b.date}T00:00:00+05:30`,
      open: b.open,
      high: b.high,
      low: b.low,
      close: b.close,
      volume: b.volume,
      provider: "fyers",
      freshness: "EOD",
      is_complete: true,
    })),
    { conflict: ["instrument_id", "interval", "ts", "provider"] }
  );
}

/**
 * Fetches the trailing 15-minute window, splits it into close-confirmed
 * bars (via this repo's own buy-setup/fifteen-minute-bars.js normalizer --
 * reused verbatim, not reimplemented) and the one still-forming trailing
 * candle (display-only, via fome/provisional-candle.js), and persists ONLY
 * the close-confirmed bars into fome_fifteen_minute_bars -- the provisional
 * candle is never written to the immutable evidence table.
 */
async function fetchFifteenMinuteEvidence(db, instrument, asOfTimestamp, runId) {
  const { data: rawFifteenMin } = await fetchFifteenMinuteOHLCV(instrument.id, instrument.symbol, db, { asOfTimestamp });
  const closeConfirmedFifteenMin = normalizeCompletedFifteenMinuteBars(rawFifteenMin, asOfTimestamp);
  const provisionalCandle = extractProvisionalFifteenMinuteCandle(rawFifteenMin, asOfTimestamp);

  if (closeConfirmedFifteenMin.length > 0) {
    await upsertMany(
      db,
      "fome_fifteen_minute_bars",
      closeConfirmedFifteenMin.map((b) => ({
        analysis_run_id: runId,
        instrument_id: instrument.id,
        session_date: b.sessionDate,
        ts: b.ts,
        open: b.open,
        high: b.high,
        low: b.low,
        close: b.close,
        volume: b.volume,
        provider: "fyers",
        is_complete: true,
      })),
      { conflict: ["analysis_run_id", "ts"] }
    );
  }

  return { rawFifteenMin: rawFifteenMin ?? [], closeConfirmedFifteenMin, provisionalCandle };
}

/**
 * Cache-reuse policy for Monthly/Weekly rows. Looks at this instrument's
 * most recent PRIOR analysis run's row for the same timeframe; reuses it
 * (with `reused_from_run_id` set) when the hash and both versions match,
 * otherwise recomputes.
 */
async function buildOrReuseTimeframeRow(db, { instrumentId, timeframe, timeframeBars, documentedParams, parameterVersion, currentRunId }) {
  const inputHash = computeFomeTimeframeInputHash({
    timeframeBars,
    algorithmVersion: FOME_TIMEFRAME_RESPONSIBILITY_VERSION,
    parameterVersion,
    adjustmentVersion: ADJUSTMENT_VERSION,
  });

  const priorRun = await db.one(
    `select id from fome_analysis_runs
      where instrument_id = $1 and status in ('completed', 'partial') and id <> $2
      order by created_at desc limit 1`,
    [instrumentId, currentRunId],
  );

  if (priorRun) {
    const priorRow = await db.one("select * from fome_timeframe_results where analysis_run_id = $1 and timeframe = $2", [priorRun.id, timeframe]);
    if (priorRow && priorRow.input_hash === inputHash) {
      const reusedRow = rowFromDb(priorRow);
      reusedRow.explanation = `${reusedRow.explanation} (Reused from a prior analysis -- inputs and versions are unchanged.)`;
      await persistTimeframeRow(db, currentRunId, reusedRow, { inputHash, reusedFromRunId: priorRun.id });
      return reusedRow;
    }
  }

  const freshRow = buildFomeTimeframeRow(timeframe, timeframeBars, documentedParams, { freshness: "EOD" });
  await persistTimeframeRow(db, currentRunId, freshRow, { inputHash });
  return freshRow;
}

function rowFromDb(dbRow) {
  return {
    timeframe: dbRow.timeframe,
    latestCompletedCandle: dbRow.latest_completed_candle_at,
    freshness: dbRow.freshness,
    isProvisional: dbRow.is_provisional,
    dowState: dbRow.dow_state,
    pivotSequence: dbRow.pivot_sequence,
    macdState: dbRow.macd_state,
    rsi: dbRow.rsi,
    adx: dbRow.adx,
    adxSlope: dbRow.adx_slope,
    bollingerState: dbRow.bollinger_state,
    bollingerPriceLocation: dbRow.bollinger_price_location,
    support: dbRow.support,
    resistance: dbRow.resistance,
    breakoutState: dbRow.breakout_state,
    direction: dbRow.direction,
    confidence: dbRow.confidence,
    explanation: dbRow.explanation,
  };
}

async function persistTimeframeRow(db, runId, row, { inputHash = null, reusedFromRunId = null } = {}) {
  await upsertMany(
    db,
    "fome_timeframe_results",
    [{
      analysis_run_id: runId,
      timeframe: row.timeframe,
      latest_completed_candle_at: row.latestCompletedCandle,
      freshness: row.freshness,
      is_provisional: row.isProvisional,
      dow_state: row.dowState,
      pivot_sequence: row.pivotSequence,
      macd_state: row.macdState,
      rsi: row.rsi,
      adx: row.adx,
      adx_slope: row.adxSlope,
      bollinger_state: row.bollingerState,
      bollinger_price_location: row.bollingerPriceLocation,
      support: row.support,
      resistance: row.resistance,
      breakout_state: row.breakoutState,
      direction: row.direction,
      confidence: row.confidence,
      explanation: row.explanation,
      input_hash: inputHash,
      reused_from_run_id: reusedFromRunId,
    }],
    { conflict: ["analysis_run_id", "timeframe"] }
  );
}

/**
 * Renders the Daily and 15-minute charts (fome/../charts/render-fome.js) and
 * uploads them content-addressed into the SAME Storage bucket buy-setup's
 * own charts use (direction-charts), reusing immutable-path.js's identity
 * scheme verbatim -- identical bytes reuse the same object path, an upload
 * conflict on an already-existing identical object is treated as success.
 * Never blocks the rest of the analysis on a storage failure -- a chart is
 * a presentation aid, not authoritative evidence, so its own failure is
 * recorded (chart_object_path stays null) rather than failing the run.
 */
async function renderAndStoreCharts(db, chartStore, runId, instrument, { dailyBars, dailyRow, closeConfirmedFifteenMin, provisionalCandle, fifteenMinRow }) {
  const dailySvg = renderFomeChart({
    symbol: instrument.symbol,
    timeframe: "daily",
    bars: dailyBars,
    support: dailyRow.support,
    resistance: dailyRow.resistance,
    target: dailyRow.direction === "bullish" ? dailyRow.resistance : dailyRow.direction === "bearish" ? dailyRow.support : null,
    invalidation: dailyRow.direction === "bullish" ? dailyRow.support : dailyRow.direction === "bearish" ? dailyRow.resistance : null,
    latestCompletedCandleAt: dailyRow.latestCompletedCandle,
  });
  await storeChart(db, chartStore, runId, instrument.id, "daily", dailySvg);

  const fifteenMinSvg = renderFomeChart({
    symbol: instrument.symbol,
    timeframe: "15m",
    bars: closeConfirmedFifteenMin.map((b) => ({ date: b.ts, open: b.open, high: b.high, low: b.low, close: b.close })),
    provisionalCandle,
    support: fifteenMinRow.support,
    resistance: fifteenMinRow.resistance,
    latestCompletedCandleAt: fifteenMinRow.latestCompletedCandle,
  });
  await storeChart(db, chartStore, runId, instrument.id, "15m", fifteenMinSvg);
}

async function storeChart(db, chartStore, runId, instrumentId, timeframe, svg) {
  try {
    const { objectPath, contentHash } = await immutableChartIdentity(instrumentId, `fome-${timeframe}`, svg);
    await chartStore.putSvg(objectPath, svg); // immutable: an identical existing object is success

    await updateWhere(db, "fome_timeframe_results", { chart_object_path: objectPath, chart_content_hash: contentHash }, { analysis_run_id: runId, timeframe });
  } catch (err) {
    // Chart storage is presentation-only -- log via pipeline_audit_log-style
    // best-effort, never fail the whole analysis over a Storage outage.
    console.error(`[fome-analysis] chart storage failed for run=${runId} timeframe=${timeframe}: ${safeErrorMessage(err)}`);
  }
}

/**
 * Best-effort derivative retrieval: ineligible (never fabricated) when the
 * instrument has no current futures contract on Fyers, or when any provider
 * call fails. "Do not treat the existence of a Fyers response alone as
 * authoritative derivative eligibility" -- a contract must also carry a
 * real, live quote (hasLiveQuote) to count.
 */
async function retrieveDerivativeData(db, instrument, spot, asOfTimestamp) {
  const underlyingSymbol = toFyersSymbol(instrument.id, instrument.symbol);
  const ineligible = { eligible: false, ruleInputs: null, lotSize: null, selectedExpiry: null, selectedExpiryEpoch: null, spotDerivativeAligned: null, spotDerivativeSkewReason: null };
  try {
    const futuresChain = await fetchFuturesChain(underlyingSymbol, db);
    const { selected: nearFuture } = selectNearestExpiry(futuresChain.contracts, asOfTimestamp);
    if (!nearFuture) return ineligible;

    const depthRetrievedAt = new Date();
    const depth = await fetchMarketDepth(nearFuture.symbol, db).catch(() => null);
    // Fyers' depth response carries no own provider timestamp field -- the
    // retrieval instant stands in for it (disclosed via freshness:"LIVE").
    // Only computed/enforced when depth data actually came back: a missing
    // depth response is a genuine NO_DATA for futures OI specifically, not a
    // "mismatched timestamp" for the whole derivative overlay (options
    // strategies below never depend on this depth call at all).
    const alignment = depth ? checkSpotDerivativeAlignment(asOfTimestamp.toISOString(), depthRetrievedAt.toISOString()) : { aligned: null, reason: null };

    const futuresOiInput =
      depth && depth.oi != null && depth.previousOi != null && nearFuture.changePct != null
        ? { priceChangePct: nearFuture.changePct, oiChangePct: depth.oiChangePct ?? ((depth.oi - depth.previousOi) / depth.previousOi) * 100 }
        : null;

    // Plain insert, not upsert: derivative_contracts (migration 0001) has no
    // natural dedup key across instrument/contract-type/expiry, so each
    // analysis records its own immutable snapshot row.
    await insertMany(db, "derivative_contracts", [{
      instrument_id: instrument.id,
      contract_type: "future",
      expiry: epochToDate(nearFuture.expiryEpoch),
      lot_size: null, // Fyers' documented futures-chain/options-chain/depth endpoints carry no lot-size field -- never invented, see fome/contract-selection.js's own header comment
      raw: nearFuture,
    }]);

    const optionChain = await fetchOptionChain(underlyingSymbol, STRIKE_COUNT, db).catch(() => null);
    let atmPut = null;
    let atmCall = null;
    let itmCall = null;
    let itmPut = null;
    let selectedExpiry = null;
    if (optionChain && spot != null) {
      const { selected } = selectNearestExpiry(optionChain.expiries, asOfTimestamp);
      selectedExpiry = selected;
      // Fyers' options-chain-v3 response does not carry a per-contract
      // expiry field (confirmed absent from its documented response
      // attributes) -- this project cannot independently filter
      // optionChain.contracts down to one specific expiry here; it uses
      // whatever single expiry the endpoint itself defaults to. Disclosed
      // limitation.
      const calls = optionChain.contracts.filter((c) => c.optionType === "CE" && hasLiveQuote(c)).sort((a, b) => a.strike - b.strike);
      const puts = optionChain.contracts.filter((c) => c.optionType === "PE" && hasLiveQuote(c)).sort((a, b) => a.strike - b.strike);
      const callLadder = selectStrikeLadder(calls, spot, "CE");
      const putLadder = selectStrikeLadder(puts, spot, "PE");
      atmCall = callLadder.atm;
      itmCall = callLadder.itm;
      atmPut = putLadder.atm;
      itmPut = putLadder.itm;
    }

    const ruleInputs = {
      futures: futuresOiInput,
      atmPutOiChangePct: atmPut?.oiChangePct ?? null,
      atmOrItmCallOiChangePct: itmCall?.oiChangePct ?? atmCall?.oiChangePct ?? null,
      atmOrItmPutOiChangePct: itmPut?.oiChangePct ?? atmPut?.oiChangePct ?? null,
      atmCallOiChangePct: atmCall?.oiChangePct ?? null,
    };

    return {
      eligible: true,
      ruleInputs,
      spot,
      lotSize: null,
      nearFuture,
      futuresDepth: depth,
      optionChain,
      atmCall,
      atmPut,
      itmCall,
      itmPut,
      selectedExpiry: selectedExpiry ? epochToDate(selectedExpiry.expiryEpoch) : null,
      selectedExpiryEpoch: selectedExpiry?.expiryEpoch ?? null,
      spotDerivativeAligned: alignment.aligned,
      spotDerivativeSkewReason: alignment.aligned ? null : alignment.reason,
    };
  } catch (err) {
    // An expired/invalid FYERS token must fail loudly (with the rotation hint),
    // never masquerade as "this instrument has no derivatives".
    if (err instanceof FyersAuthError) throw err;
    // Any other provider failure (unsupported instrument, network error) --
    // degrade honestly rather than throwing and failing the whole analysis; the
    // technical/direction result is still valid without it.
    return ineligible;
  }
}

function epochToDate(epochSeconds) {
  const n = Number(epochSeconds);
  return Number.isFinite(n) ? new Date(n * 1000).toISOString().slice(0, 10) : null;
}

/**
 * Regime classification feeding strategies/fome.yaml's `strategy_mapping` /
 * fome/strategy-comparison.js's REGIME_STRATEGY_FAMILIES -- a disclosed
 * PROJECT_DEFAULT synthesis of the final alignment plus Daily ADX/Bollinger
 * momentum evidence.
 */
function deriveRegime(alignment, dailyRow) {
  const strongMomentum = dailyRow.adx != null && dailyRow.adx >= 20 && dailyRow.adxSlope === "rising";
  switch (alignment.finalAlignment) {
    case "ALIGNED_BULLISH":
      return strongMomentum ? "strong_bullish" : "moderate_bullish_or_near_support";
    case "ALIGNED_BEARISH":
      return strongMomentum ? "strong_bearish" : "moderate_bearish_or_near_resistance";
    case "SIDEWAYS":
      return "restricted_range";
    case "VOLATILITY_EXPANSION":
      return "large_move_either_direction";
    default:
      return null; // MIXED / WAIT_FOR_ENTRY_CONFIRMATION / MANUAL_REVIEW / UNAVAILABLE -> never force a recommendation
  }
}

function buildStrategyComparison(regime, { spot, derivative, dailyRow }) {
  if (!derivative.eligible || spot == null) {
    return { regime, candidates: [], bestFit: null, reason: "No current derivative contract data is available for this instrument." };
  }
  if (derivative.spotDerivativeAligned === false) {
    return { regime, candidates: [], bestFit: null, reason: `Spot and derivative timestamps are materially mismatched (${derivative.spotDerivativeSkewReason}) -- no contract-level qualification is produced from misaligned data.` };
  }

  const { atmCall, atmPut, itmCall, itmPut, nearFuture } = derivative;
  const lotSize = derivative.lotSize; // null unless a real source resolves it -- every builder below already refuses to compute without one
  const futuresEntry = nearFuture?.lastPrice ?? spot;
  const atmStrike = atmCall?.strike ?? atmPut?.strike ?? Math.round(spot / 50) * 50;
  const otmCall = derivative.optionChain?.contracts.filter((c) => c.optionType === "CE" && c.strike > atmStrike).sort((a, b) => a.strike - b.strike)[0];
  const otmPut = derivative.optionChain?.contracts.filter((c) => c.optionType === "PE" && c.strike < atmStrike).sort((a, b) => b.strike - a.strike)[0];

  const builders = {
    long_futures: () => (futuresEntry != null ? longFutures({ entryPrice: futuresEntry, target: dailyRow.resistance, invalidation: dailyRow.support, lotSize }) : null),
    short_futures: () => (futuresEntry != null ? shortFutures({ entryPrice: futuresEntry, target: dailyRow.support, invalidation: dailyRow.resistance, lotSize }) : null),
    long_call: () => (atmCall?.ltp != null ? longCall({ strike: atmCall.strike, premium: atmCall.ltp, lotSize }) : null),
    long_put: () => (atmPut?.ltp != null ? longPut({ strike: atmPut.strike, premium: atmPut.ltp, lotSize }) : null),
    bull_call_spread: () => (atmCall?.ltp != null && otmCall?.ltp != null ? bullCallSpread({ longStrike: atmCall.strike, longPremium: atmCall.ltp, shortStrike: otmCall.strike, shortPremium: otmCall.ltp, lotSize }) : null),
    bear_put_spread: () => (atmPut?.ltp != null && otmPut?.ltp != null ? bearPutSpread({ longStrike: atmPut.strike, longPremium: atmPut.ltp, shortStrike: otmPut.strike, shortPremium: otmPut.ltp, lotSize }) : null),
    bull_put_spread: () => (atmPut?.ltp != null && otmPut?.ltp != null ? bullPutSpread({ shortStrike: atmPut.strike, shortPremium: atmPut.ltp, longStrike: otmPut.strike, longPremium: otmPut.ltp, lotSize }) : null),
    bear_call_spread: () => (atmCall?.ltp != null && otmCall?.ltp != null ? bearCallSpread({ shortStrike: atmCall.strike, shortPremium: atmCall.ltp, longStrike: otmCall.strike, longPremium: otmCall.ltp, lotSize }) : null),
    bullish_call_ratio_spread: () => (atmCall?.ltp != null && otmCall?.ltp != null ? bullishCallRatioSpread({ longStrike: atmCall.strike, longPremium: atmCall.ltp, shortStrike: otmCall.strike, shortPremium: otmCall.ltp, lotSize }) : null),
    bearish_put_ratio_spread: () => (atmPut?.ltp != null && otmPut?.ltp != null ? bearishPutRatioSpread({ longStrike: atmPut.strike, longPremium: atmPut.ltp, shortStrike: otmPut.strike, shortPremium: otmPut.ltp, lotSize }) : null),
    covered_call: () => (atmCall?.ltp != null ? coveredCall({ spot, callStrike: atmCall.strike, callPremium: atmCall.ltp, lotSize }) : null),
    covered_put: () => (atmPut?.ltp != null ? coveredPut({ spot, putStrike: atmPut.strike, putPremium: atmPut.ltp, lotSize }) : null),
    long_collar: () => (atmPut?.ltp != null && otmCall?.ltp != null ? longCollar({ spot, putStrike: atmPut.strike, putPremium: atmPut.ltp, callStrike: otmCall.strike, callPremium: otmCall.ltp, lotSize }) : null),
    short_collar: () => (atmCall?.ltp != null && otmPut?.ltp != null ? shortCollar({ spot, callStrike: atmCall.strike, callPremium: atmCall.ltp, putStrike: otmPut.strike, putPremium: otmPut.ltp, lotSize }) : null),
    long_straddle: () => (atmCall?.ltp != null && atmPut?.ltp != null ? longStraddle({ strike: atmStrike, callPremium: atmCall.ltp, putPremium: atmPut.ltp, lotSize }) : null),
    long_strangle: () => (otmCall?.ltp != null && otmPut?.ltp != null ? longStrangle({ callStrike: otmCall.strike, callPremium: otmCall.ltp, putStrike: otmPut.strike, putPremium: otmPut.ltp, lotSize }) : null),
    short_iron_butterfly: () => buildIronStrikes(shortIronButterfly, { atmCall, atmPut, otmCall, otmPut, lotSize }),
    short_iron_condor: () => buildIronStrikes(shortIronCondor, { atmCall, atmPut, otmCall, otmPut, lotSize }),
    long_iron_butterfly: () => buildIronStrikes(longIronButterfly, { atmCall, atmPut, otmCall, otmPut, lotSize }),
    long_iron_condor: () => buildIronStrikes(longIronCondor, { atmCall, atmPut, otmCall, otmPut, lotSize }),
    calendar_spread: () =>
      derivative.optionChain?.expiries?.length > 1
        ? calendarSpread({ nearExpiry: derivative.optionChain.expiries[0].date, farExpiry: derivative.optionChain.expiries[1].date, strike: atmStrike })
        : null,
  };

  return compareStrategies(regime, builders);
}

function buildIronStrikes(builder, { atmCall, atmPut, otmCall, otmPut, lotSize }) {
  if (!atmCall?.ltp || !atmPut?.ltp || !otmCall?.ltp || !otmPut?.ltp) return null;
  return builder({
    putLongStrike: otmPut.strike,
    putShortStrike: atmPut.strike,
    callShortStrike: atmCall.strike,
    callLongStrike: otmCall.strike,
    putLongPremium: otmPut.ltp,
    putShortPremium: atmPut.ltp,
    callShortPremium: atmCall.ltp,
    callLongPremium: otmCall.ltp,
    lotSize,
  });
}

async function finalizeRun(
  db,
  runId,
  {
    status,
    dataQuality,
    finalAlignment,
    alignmentReason,
    underlyingAlignment = null,
    derivativeEligible = null,
    derivativeSource = null,
    selectedExpiry = null,
    selectedExpiryEpoch = null,
    spotDerivativeAligned = null,
    spotDerivativeSkewReason = null,
    ruleVersion = null,
    parameterVersion = null,
  }
) {
  await setStage(db, runId, "saving_and_presenting_result");
  await updateWhere(
    db,
    "fome_analysis_runs",
    {
      status,
      data_quality: dataQuality,
      final_alignment: finalAlignment,
      alignment_reason: alignmentReason,
      underlying_alignment: underlyingAlignment,
      derivative_eligible: derivativeEligible,
      derivative_source: derivativeSource,
      selected_expiry: selectedExpiry,
      selected_expiry_epoch: selectedExpiryEpoch != null ? String(selectedExpiryEpoch) : null,
      spot_derivative_aligned: spotDerivativeAligned,
      spot_derivative_skew_reason: spotDerivativeSkewReason,
      rule_version: ruleVersion,
      parameter_version: parameterVersion,
      completed_at: new Date().toISOString(),
    },
    { id: runId },
  );
}

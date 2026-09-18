// fome-analysis Edge Function -- single-instrument, on-demand FOME analysis
// for the /fome page. Deliberately NOT the full-universe run-screening
// pipeline, and NOT built on top of buy-setup's manifest/pipeline-batch
// design (that system is hard-coupled to an already-published
// screening_runs universe -- see fome_analysis_runs' own migration comment
// for why that's the wrong foundation for an ad hoc single-instrument
// request). This analyzes exactly the one instrument the caller names,
// refreshes only that instrument's data, and is expected to complete in a
// single invocation -- a handful of sequential Fyers calls (a bounded
// number of 366-day daily-history legs, one 15-minute fetch, one
// futures-chain, one option-chain, one depth call), comfortably inside the
// platform's wall-clock budget. Disclosed limitation: unlike run-screening,
// this function has no self-chain/resume mechanism -- if a future change
// pushes a single instrument's analysis close to the platform's hard-kill
// budget, add the same pipeline_batches-style chunking run-screening uses.
//
// Invoked by: the Next.js POST /api/fome-analysis route (any signed-in
// user), using this project's existing secret-key bearer-auth convention
// (APP_SECRET_KEYS' "default" entry -- same as run-screening/index.ts and
// analyze-buy-setup/index.ts).
//
// Responds immediately with {runId, status:"running"} and continues the
// real work in the background via EdgeRuntime.waitUntil (same pattern
// run-screening/index.ts and analyze-buy-setup/index.ts already use) -- the
// Next.js page polls GET /api/fome-analysis/{runId} for staged progress and
// the final result. News retrieval (stage 7 of the page's 10-step progress)
// is intentionally NOT done here: this project's existing news
// infrastructure (app/src/lib/news/rss.ts) is Node/Next.js-side (the
// `rss-parser` npm package has no confirmed Deno-compatible equivalent in
// this project) -- the Next.js GET route appends news once this run reaches
// a terminal technical status (see that route's own comment).

import { createClient } from "npm:@supabase/supabase-js@2";
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
import { immutableChartIdentity, isExistingChartObjectError } from "../run-screening/charts/immutable-path.js";
import { latestCompletedNseSession } from "../run-screening/nse-calendar.js";

const SUPABASE_URL = Deno.env.get("SUPABASE_URL");
// Same convention as run-screening/index.ts and analyze-buy-setup/index.ts --
// APP_SECRET_KEYS' "default" entry (this project's own equivalent of the
// deprecated SUPABASE_SERVICE_ROLE_KEY; renamed off the SUPABASE_ prefix
// because Supabase now rejects any custom secret name starting with it).
const SECRET_KEY = JSON.parse(Deno.env.get("APP_SECRET_KEYS") ?? "{}").default;
const CHART_BUCKET = "direction-charts"; // reuses the existing bucket, same as buy-setup's own storeChart()

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

Deno.serve(async (req) => {
  const authHeader = req.headers.get("Authorization") ?? "";
  if (authHeader !== `Bearer ${SECRET_KEY}`) {
    return json({ error: "Unauthorized" }, 401);
  }

  const body = await req.json().catch(() => ({}));
  const instrumentId = body.instrument_id;
  const triggeredBy = body.triggered_by ?? null;
  if (!instrumentId || typeof instrumentId !== "string") {
    return json({ error: "instrument_id is required" }, 400);
  }

  const supabase = createClient(SUPABASE_URL, SECRET_KEY);

  const { data: instrument, error: instrumentError } = await supabase
    .from("instruments")
    .select("*")
    .eq("id", instrumentId)
    .maybeSingle();
  if (instrumentError || !instrument) {
    return json({ error: `Unknown instrument_id "${instrumentId}"` }, 404);
  }

  const asOfTimestamp = new Date(); // FOME is live/on-demand, not tied to a fixed EOD boundary -- freeze "now" once, pass it through every fetch below
  const runId = crypto.randomUUID();
  await supabase.from("fome_analysis_runs").insert({
    id: runId,
    instrument_id: instrumentId,
    status: "running",
    as_of_timestamp: asOfTimestamp.toISOString(),
    current_stage: STAGES[0],
    stage_history: [{ stage: STAGES[0], at: new Date().toISOString() }],
    algorithm_version: `timeframes:${FOME_TIMEFRAME_RESPONSIBILITY_VERSION};alignment:${FOME_ALIGNMENT_LOGIC_VERSION};context:${FOME_CONTEXT_VERSION};contracts:${CONTRACT_SELECTION_VERSION}`,
    strategy_engine_version: FOME_STRATEGY_ENGINE_VERSION,
    chart_render_version: FOME_RENDER_VERSION,
    providers: { ohlcv: "fyers", derivatives: "fyers" },
    triggered_by: triggeredBy,
    started_at: new Date().toISOString(),
  });

  const pipeline = runFomeAnalysis({ supabase, runId, instrument, asOfTimestamp });
  if (typeof EdgeRuntime !== "undefined") {
    EdgeRuntime.waitUntil(pipeline);
  } else {
    await pipeline; // local `supabase functions serve` -- see run-screening/index.ts's identical comment
  }

  return json({ runId, status: "running" });
});

async function setStage(supabase, runId, stage) {
  const { data: run } = await supabase.from("fome_analysis_runs").select("stage_history").eq("id", runId).single();
  const history = [...(run?.stage_history ?? []), { stage, at: new Date().toISOString() }];
  await supabase.from("fome_analysis_runs").update({ current_stage: stage, stage_history: history }).eq("id", runId);
}

async function runFomeAnalysis({ supabase, runId, instrument, asOfTimestamp }) {
  try {
    await setStage(supabase, runId, "checking_cached_data");
    const runDate = latestCompletedNseSession(asOfTimestamp);
    const dailyBars = await ensureDailyHistory(supabase, instrument, runDate);

    const dailyValidation = validateBars(dailyBars, { asOfTimestamp: asOfTimestamp.toISOString() });
    if (dailyValidation.result === "NO_DATA" || dailyValidation.result === "INVALID") {
      await finalizeRun(supabase, runId, {
        status: "partial",
        dataQuality: dailyValidation.result,
        finalAlignment: "UNAVAILABLE",
        alignmentReason: `Daily bars are ${dailyValidation.result.toLowerCase()}: ${dailyValidation.issues.join("; ") || "no bars available"}.`,
      });
      return;
    }

    await setStage(supabase, runId, "refreshing_15m_data");
    const { rawFifteenMin, closeConfirmedFifteenMin, provisionalCandle } = await fetchFifteenMinuteEvidence(supabase, instrument, asOfTimestamp, runId);

    await setStage(supabase, runId, "building_timeframes");
    const { data: parameterVersionRow } = await supabase
      .from("parameter_versions")
      .select("*")
      .order("created_at", { ascending: false })
      .limit(1)
      .maybeSingle();
    const documentedParams = parameterVersionRow?.values?.documented ?? {};
    const parameterVersion = parameterVersionRow?.version ?? null;

    const weeklyBars = aggregateBars(dailyBars, "weekly");
    const monthlyBars = aggregateBars(dailyBars, "monthly");

    const monthlyRow = await buildOrReuseTimeframeRow(supabase, {
      instrumentId: instrument.id,
      timeframe: "monthly",
      timeframeBars: monthlyBars,
      documentedParams,
      parameterVersion,
      currentRunId: runId,
    });
    const weeklyRow = await buildOrReuseTimeframeRow(supabase, {
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
    await persistTimeframeRow(supabase, runId, dailyRow);

    const fifteenMinRow = buildFomeTimeframeRow("15m", closeConfirmedFifteenMin, documentedParams, {
      freshness: "INTRADAY",
      isProvisional: closeConfirmedFifteenMin.length === 0 && rawFifteenMin.length > 0,
    });
    if (provisionalCandle) {
      fifteenMinRow.isProvisional = true;
      fifteenMinRow.explanation += " The latest 15-minute candle is still forming and is excluded from this structure read.";
    }
    await persistTimeframeRow(supabase, runId, fifteenMinRow);

    const alignment = computeFomeAlignment({ monthly: monthlyRow, weekly: weeklyRow, daily: dailyRow, fifteenMin: fifteenMinRow });

    await setStage(supabase, runId, "retrieving_derivative_information");
    const spot = dailyBars.at(-1)?.close ?? null;
    const derivative = await retrieveDerivativeData(supabase, instrument, spot, asOfTimestamp);

    await renderAndStoreCharts(supabase, runId, instrument, {
      dailyBars,
      dailyRow,
      closeConfirmedFifteenMin,
      provisionalCandle,
      fifteenMinRow,
    });

    await setStage(supabase, runId, "applying_fome_rules");
    const ruleContext = buildFomeRuleContext({
      dailyBars,
      dailyRow,
      documentedParams,
      derivative: derivative.ruleInputs,
    });
    ruleContext.__dataSource = "fyers";

    const { data: strategyVersions } = await supabase
      .from("strategy_versions")
      .select("id, strategy_id, rule_version")
      .eq("is_active", true)
      .in("strategy_id", ["fome-original", "fome-single-instrument"]);
    const strategyVersionIds = (strategyVersions ?? []).map((v) => v.id);
    const ruleVersions = (strategyVersions ?? []).map((v) => v.rule_version).join(",");

    if (strategyVersionIds.length > 0) {
      const { data: ruleDefinitions } = await supabase
        .from("rule_definitions")
        .select("*")
        .in("strategy_version_id", strategyVersionIds);
      const { traces } = evaluateRules(ruleDefinitions ?? [], ruleContext, documentedParams);
      const enrichedTraces = traces.map((t) => {
        const def = (ruleDefinitions ?? []).find((d) => d.rule_id === t.rule_id);
        return { ...t, timeframe: def?.timeframe ?? "daily", source_status: def?.source_status ?? null };
      });
      if (enrichedTraces.length > 0) {
        await supabase.from("fome_rule_traces").insert(
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

    await setStage(supabase, runId, "comparing_strategies");
    const regime = deriveRegime(alignment, dailyRow);
    const candidates = regime
      ? buildStrategyComparison(regime, { spot, derivative, dailyRow })
      : { regime: null, candidates: [], bestFit: null, reason: "No regime could be determined from the current alignment/momentum evidence." };

    if (candidates.candidates.length > 0) {
      await supabase.from("fome_strategy_candidates").insert(
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

    await finalizeRun(supabase, runId, {
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
    await supabase
      .from("fome_analysis_runs")
      .update({ status: "failed", error_message: String(err?.stack ?? err), completed_at: new Date().toISOString() })
      .eq("id", runId);
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
async function ensureDailyHistory(supabase, instrument, runDate) {
  const { data: existingRange } = await supabase
    .from("market_bars_raw")
    .select("session_date")
    .eq("instrument_id", instrument.id)
    .eq("interval", "1d")
    .order("session_date", { ascending: true });

  if (!existingRange || existingRange.length === 0) {
    let legEnd = new Date(`${runDate}T00:00:00Z`);
    const targetStart = new Date(legEnd.getTime() - DAILY_HISTORY_TARGET_DAYS * 24 * 60 * 60 * 1000);
    while (legEnd.getTime() > targetStart.getTime()) {
      const legStart = new Date(Math.max(targetStart.getTime(), legEnd.getTime() - DAILY_HISTORY_LEG_DAYS * 24 * 60 * 60 * 1000));
      const { data } = await fetchOHLCVRange(instrument.id, instrument.symbol, legStart, legEnd, supabase);
      await writeDailyBars(supabase, instrument.id, data);
      legEnd = new Date(legStart.getTime() - 24 * 60 * 60 * 1000);
    }
  } else {
    const latestStoredSessionDate = existingRange[existingRange.length - 1].session_date;
    const range = nextIncrementalRange(latestStoredSessionDate, runDate, DAILY_HISTORY_TARGET_DAYS);
    if (range) {
      const { data } = await fetchOHLCVRange(instrument.id, instrument.symbol, range.from, range.to, supabase);
      await writeDailyBars(supabase, instrument.id, data);
    }
  }

  const windowStart = new Date(new Date(`${runDate}T00:00:00Z`).getTime() - DAILY_HISTORY_TARGET_DAYS * 24 * 60 * 60 * 1000)
    .toISOString()
    .slice(0, 10);
  const { data: storedBars } = await supabase
    .from("market_bars_raw")
    .select("session_date, open, high, low, close, volume")
    .eq("instrument_id", instrument.id)
    .eq("interval", "1d")
    .gte("session_date", windowStart)
    .lte("session_date", runDate)
    .order("session_date", { ascending: true });

  return (storedBars ?? []).map((b) => ({ date: b.session_date, open: b.open, high: b.high, low: b.low, close: b.close, volume: b.volume }));
}

async function writeDailyBars(supabase, instrumentId, bars) {
  if (!bars || bars.length === 0) return;
  await supabase.from("market_bars_raw").upsert(
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
    { onConflict: "instrument_id,interval,ts,provider" }
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
async function fetchFifteenMinuteEvidence(supabase, instrument, asOfTimestamp, runId) {
  const { data: rawFifteenMin } = await fetchFifteenMinuteOHLCV(instrument.id, instrument.symbol, supabase, { asOfTimestamp });
  const closeConfirmedFifteenMin = normalizeCompletedFifteenMinuteBars(rawFifteenMin, asOfTimestamp);
  const provisionalCandle = extractProvisionalFifteenMinuteCandle(rawFifteenMin, asOfTimestamp);

  if (closeConfirmedFifteenMin.length > 0) {
    await supabase.from("fome_fifteen_minute_bars").upsert(
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
      { onConflict: "analysis_run_id,ts" }
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
async function buildOrReuseTimeframeRow(supabase, { instrumentId, timeframe, timeframeBars, documentedParams, parameterVersion, currentRunId }) {
  const inputHash = computeFomeTimeframeInputHash({
    timeframeBars,
    algorithmVersion: FOME_TIMEFRAME_RESPONSIBILITY_VERSION,
    parameterVersion,
    adjustmentVersion: ADJUSTMENT_VERSION,
  });

  const { data: priorRun } = await supabase
    .from("fome_analysis_runs")
    .select("id")
    .eq("instrument_id", instrumentId)
    .in("status", ["completed", "partial"])
    .neq("id", currentRunId)
    .order("created_at", { ascending: false })
    .limit(1)
    .maybeSingle();

  if (priorRun) {
    const { data: priorRow } = await supabase
      .from("fome_timeframe_results")
      .select("*")
      .eq("analysis_run_id", priorRun.id)
      .eq("timeframe", timeframe)
      .maybeSingle();
    if (priorRow && priorRow.input_hash === inputHash) {
      const reusedRow = rowFromDb(priorRow);
      reusedRow.explanation = `${reusedRow.explanation} (Reused from a prior analysis -- inputs and versions are unchanged.)`;
      await persistTimeframeRow(supabase, currentRunId, reusedRow, { inputHash, reusedFromRunId: priorRun.id });
      return reusedRow;
    }
  }

  const freshRow = buildFomeTimeframeRow(timeframe, timeframeBars, documentedParams, { freshness: "EOD" });
  await persistTimeframeRow(supabase, currentRunId, freshRow, { inputHash });
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

async function persistTimeframeRow(supabase, runId, row, { inputHash = null, reusedFromRunId = null } = {}) {
  await supabase.from("fome_timeframe_results").upsert(
    {
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
    },
    { onConflict: "analysis_run_id,timeframe" }
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
async function renderAndStoreCharts(supabase, runId, instrument, { dailyBars, dailyRow, closeConfirmedFifteenMin, provisionalCandle, fifteenMinRow }) {
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
  await storeChart(supabase, runId, instrument.id, "daily", dailySvg);

  const fifteenMinSvg = renderFomeChart({
    symbol: instrument.symbol,
    timeframe: "15m",
    bars: closeConfirmedFifteenMin.map((b) => ({ date: b.ts, open: b.open, high: b.high, low: b.low, close: b.close })),
    provisionalCandle,
    support: fifteenMinRow.support,
    resistance: fifteenMinRow.resistance,
    latestCompletedCandleAt: fifteenMinRow.latestCompletedCandle,
  });
  await storeChart(supabase, runId, instrument.id, "15m", fifteenMinSvg);
}

async function storeChart(supabase, runId, instrumentId, timeframe, svg) {
  try {
    const { objectPath, contentHash } = await immutableChartIdentity(instrumentId, `fome-${timeframe}`, svg);
    const { error: uploadError } = await supabase.storage
      .from(CHART_BUCKET)
      .upload(objectPath, new Blob([svg], { type: "image/svg+xml" }), { contentType: "image/svg+xml", upsert: false });
    if (uploadError && !isExistingChartObjectError(uploadError)) throw uploadError;

    await supabase
      .from("fome_timeframe_results")
      .update({ chart_object_path: objectPath, chart_content_hash: contentHash })
      .eq("analysis_run_id", runId)
      .eq("timeframe", timeframe);
  } catch (err) {
    // Chart storage is presentation-only -- log via pipeline_audit_log-style
    // best-effort, never fail the whole analysis over a Storage outage.
    console.error(`[fome-analysis] chart storage failed for run=${runId} timeframe=${timeframe}:`, err);
  }
}

/**
 * Best-effort derivative retrieval: ineligible (never fabricated) when the
 * instrument has no current futures contract on Fyers, or when any provider
 * call fails. "Do not treat the existence of a Fyers response alone as
 * authoritative derivative eligibility" -- a contract must also carry a
 * real, live quote (hasLiveQuote) to count.
 */
async function retrieveDerivativeData(supabase, instrument, spot, asOfTimestamp) {
  const underlyingSymbol = toFyersSymbol(instrument.id, instrument.symbol);
  const ineligible = { eligible: false, ruleInputs: null, lotSize: null, selectedExpiry: null, selectedExpiryEpoch: null, spotDerivativeAligned: null, spotDerivativeSkewReason: null };
  try {
    const futuresChain = await fetchFuturesChain(underlyingSymbol, supabase);
    const { selected: nearFuture } = selectNearestExpiry(futuresChain.contracts, asOfTimestamp);
    if (!nearFuture) return ineligible;

    const depthRetrievedAt = new Date();
    const depth = await fetchMarketDepth(nearFuture.symbol, supabase).catch(() => null);
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
    await supabase.from("derivative_contracts").insert({
      instrument_id: instrument.id,
      contract_type: "future",
      expiry: epochToDate(nearFuture.expiryEpoch),
      lot_size: null, // Fyers' documented futures-chain/options-chain/depth endpoints carry no lot-size field -- never invented, see fome/contract-selection.js's own header comment
      raw: nearFuture,
    });

    const optionChain = await fetchOptionChain(underlyingSymbol, STRIKE_COUNT, supabase).catch(() => null);
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
  } catch {
    // Any provider failure (expired token, unsupported instrument, network
    // error) -- degrade honestly rather than throwing and failing the whole
    // analysis; the technical/direction result is still valid without it.
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
  supabase,
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
  await setStage(supabase, runId, "saving_and_presenting_result");
  await supabase
    .from("fome_analysis_runs")
    .update({
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
    })
    .eq("id", runId);
}

function json(body, status = 200) {
  return new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });
}

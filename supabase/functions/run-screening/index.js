// run-screening Edge Function -- the orchestrator described in
// references/technical-architecture.md's "Job sequence":
//   universe -> ingest -> validate -> features -> rule evaluation ->
//   ranking -> coverage reconciliation -> persist -> (publish only if
//   reconciled).
//
// Invoked either by pg_cron on the EOD schedule, or by the Next.js
// POST /api/screening-runs route (Researcher+ only) -- both call this URL
// with the project's secret key (SUPABASE_SECRET_KEYS' "default" entry) as
// a Bearer token, which is also this function's own auth check below.
//
// NOTE: written and unit-tested at the module level under Node (see the
// sibling *.test.js files, run via `npm test` from stock-platform/), but
// this entrypoint itself requires the Deno runtime (Deno.serve, npm: import
// specifiers).
//
// Data sources (as of 2026-09-07): index constituent lists come from NSE's
// static archive CSVs (providers/nse-archives.js); OHLCV comes from Fyers'
// licensed data API (providers/fyers.js). The original all-in-one NSE public
// endpoint scraper (providers/nse-public.js) is retired from this pipeline --
// its interactive API blocked Supabase's egress IPs with a 403 on every
// index, confirmed via a real deployed run (see pipeline_audit_log for run
// 8b6cb557-a990-4b72-8ba5-d8f99ea2dece). The file is kept for reference/in
// case a future environment isn't blocked, but nothing here imports it.

import { createClient } from "npm:@supabase/supabase-js@2";
import { fetchIndexConstituents } from "./providers/nse-archives.js";
import { fetchOHLCV } from "./providers/fyers.js";
import { validateBars } from "./quality.js";
import { buildFeatureContext } from "./features/context.js";
import { buildDirectionAnalysis } from "./features/direction.js";
import { detectCandlestickPatterns, detectDoubleExtremePatterns, PATTERN_PARAM_VERSION } from "./features/patterns.js";
import { computeAdjustedBars, ADJUSTMENT_VERSION } from "./features/corporate-actions.js";
import { renderChartSvg } from "./charts/render.js";
import { evaluateRules } from "./rules/evaluate.js";
import { classify, scoreComponents, rankWithinTiers } from "./rank.js";
import { reconcileCoverage } from "./reconcile.js";
import { acquireRunLease, heartbeatRunLease, releaseRunLease } from "./run-lease.js";
import { latestCompletedNseSession } from "./nse-calendar.js";

const DIRECTION_TIMEFRAMES = ["daily", "weekly", "monthly"];
const RUN_TYPE = "eod_screening";
// Heartbeat often enough that a lease with a 10-minute expiry (run-lease.js's
// default) never lapses mid-run just because this loop is slow on a given
// instrument, but not so often it adds meaningful overhead.
const HEARTBEAT_EVERY_N_INSTRUMENTS = 25;

const SUPABASE_URL = Deno.env.get("SUPABASE_URL");
// SUPABASE_SERVICE_ROLE_KEY is deprecated on this project (it migrated to
// Supabase's JWT-signing-key system, confirmed via the project's own
// Edge Functions > Secrets page) -- the reserved legacy env var no longer
// carries a usable key there. SUPABASE_SECRET_KEYS is the current
// equivalent: a JSON dict of named secret keys, same bypass-RLS privileges,
// see https://supabase.com/docs/guides/functions/secrets.
const SECRET_KEY = JSON.parse(Deno.env.get("SUPABASE_SECRET_KEYS") ?? "{}").default;
const INDEX_IDS = ["nifty-50", "nifty-bank", "nifty-100", "nifty-500"];
const UNIVERSE_VERSION = "1.0.0";
// Fyers caps a single daily-resolution history request at 366 days
// ("Date range cannot exceed 366 days for 1D, 1W, and 1M resolutions" --
// confirmed via a live 422 response); 365 stays safely under that while
// still covering a full year (documented ema_periods needs at most 200
// bars, so ~250 trading days in a year is comfortably enough).
const OHLCV_LOOKBACK_DAYS = 365;

// Supabase Edge Functions have a wall-clock limit (150s free tier, 400s
// paid) that is tighter than the time needed to fetch ~500 instruments
// while respecting Fyers' 200/min rate limit (~152s minimum in the ideal
// case -- see providers/fyers.js). Rather than risk a hard kill mid-run
// (which would leave the row stuck in "running" forever), this stops
// attempting new fetches once the budget is spent and gives every
// remaining instrument an honest "unavailable" result instead of silently
// omitting it -- coverage_reconciliation still balances, and a rerun
// (manual or the next scheduled one) picks up where this one left off.
const TIME_BUDGET_MS = 125_000;

Deno.serve(async (req) => {
  const startedAtMs = Date.now();
  const authHeader = req.headers.get("Authorization") ?? "";
  if (authHeader !== `Bearer ${SECRET_KEY}`) {
    return json({ error: "Unauthorized" }, 401);
  }

  const body = await req.json().catch(() => ({}));
  const triggerType = body.trigger_type === "scheduled" ? "scheduled" : "manual";
  const triggeredBy = body.triggered_by ?? null;

  const supabase = createClient(SUPABASE_URL, SECRET_KEY);
  const runId = crypto.randomUUID();

  // A run regularly exceeds the caller's own timeout (Netlify's serverless
  // function budget is well under this function's ~125s TIME_BUDGET_MS), so
  // a client-side retry or an impatient repeat click otherwise stacks up
  // concurrent runs -- each pacing its own Fyers calls independently, which
  // multiplies the effective request rate past Fyers' 200/min cap (see
  // providers/fyers.js's own comment on what that risks). acquireRunLease is
  // a single atomic UPDATE...WHERE...RETURNING (see run-lease.js) -- unlike
  // the select-then-insert check this replaced (which is what let 5 runs
  // stack up during this session's actual incident), there is no window
  // where two concurrent invocations can both see "free" and both proceed.
  const lease = await acquireRunLease(supabase, RUN_TYPE, runId);
  if (!lease.acquired) {
    const { data: activeLease } = await supabase
      .from("screening_run_leases")
      .select("run_id, acquired_at")
      .eq("run_type", RUN_TYPE)
      .maybeSingle();
    return json({
      runId: activeLease?.run_id ?? null,
      status: "running",
      note: `A run (leased ${activeLease?.acquired_at ?? "recently"}) is already in progress; not starting another.`,
    });
  }
  // The run's own metadata date is the latest NSE session that has actually
  // closed, in Asia/Kolkata -- not "today in UTC" (problem #22). These can
  // differ by a full calendar day (e.g. a run triggered at 02:00 UTC is
  // still within the prior IST trading day) and matter for which session's
  // bars this run is meant to represent.
  const runDate = latestCompletedNseSession(new Date());

  const { data: parameterVersion } = await supabase
    .from("parameter_versions")
    .select("*")
    .order("created_at", { ascending: false })
    .limit(1)
    .maybeSingle();
  const parameterValues = flattenParameters(parameterVersion?.values ?? {});

  const { data: strategyVersions } = await supabase
    .from("strategy_versions")
    .select("id, framework")
    .eq("is_active", true);

  const strategyVersionIds = (strategyVersions ?? []).map((v) => v.id);
  const { data: ruleDefinitions } = strategyVersionIds.length
    ? await supabase.from("rule_definitions").select("*").in("strategy_version_id", strategyVersionIds)
    : { data: [] };

  const ruleDirectionById = Object.fromEntries((ruleDefinitions ?? []).map((r) => [r.rule_id, r.direction]));

  await supabase.from("screening_runs").insert({
    id: runId,
    run_date: runDate,
    mode: "EOD",
    status: "running",
    universe_version: UNIVERSE_VERSION,
    parameter_version_id: parameterVersion?.id ?? null,
    strategy_version_ids: strategyVersionIds,
    providers: { universe: "nse_archives", ohlcv: "fyers" },
    trigger_type: triggerType,
    triggered_by: triggeredBy,
    started_at: new Date().toISOString(),
  });
  await logStage(supabase, runId, "start", "ok", `Run started (${triggerType})`);

  // The actual ingestion/rule-evaluation work below routinely runs past any
  // caller's own HTTP timeout (that's the whole reason TIME_BUDGET_MS exists
  // at 125s). Rather than make the caller block for it -- which is what
  // produced the 502s that led to the pile-up above -- acknowledge the run
  // as started immediately and finish the work in the background via
  // EdgeRuntime.waitUntil (https://supabase.com/docs/guides/functions/background-tasks).
  const pipeline = runPipeline({
    supabase,
    runId,
    runDate,
    startedAtMs,
    parameterValues,
    ruleDefinitions: ruleDefinitions ?? [],
    ruleDirectionById,
  });
  if (typeof EdgeRuntime !== "undefined") {
    EdgeRuntime.waitUntil(pipeline);
  } else {
    // Local `supabase functions serve` without per_worker policy would kill
    // the isolate before a detached background task finishes -- await it
    // there instead so local smoke-testing still sees a real result.
    await pipeline;
  }

  return json({ runId, status: "running" });
});

async function runPipeline({ supabase, runId, runDate, startedAtMs, parameterValues, ruleDefinitions, ruleDirectionById }) {
  try {
    const membership = await buildUniverse(supabase, runId, runDate);
    const allInstruments = [
      ...INDEX_IDS.map((id) => ({ instrumentId: id, symbol: id, isIndex: true })),
      ...[...membership.entries()].map(([id, m]) => ({ instrumentId: id, symbol: m.symbol, isIndex: false })),
    ];
    await logStage(
      supabase,
      runId,
      "universe",
      "ok",
      `${INDEX_IDS.length} indexes, ${membership.size} unique constituents`
    );

    const stockResults = [];
    const rankingInputs = [];
    let budgetExceededCount = 0;

    for (const [index, instrument] of allInstruments.entries()) {
      if (index > 0 && index % HEARTBEAT_EVERY_N_INSTRUMENTS === 0) {
        await heartbeatRunLease(supabase, RUN_TYPE);
      }

      const overBudget = Date.now() - startedAtMs > TIME_BUDGET_MS;
      if (overBudget) budgetExceededCount++;

      const { resultRow, componentScores } = overBudget
        ? await recordSkippedForTimeBudget({ supabase, runId, instrument })
        : await evaluateInstrument({
            supabase,
            runId,
            instrument,
            ruleDefinitions,
            parameterValues,
            ruleDirectionById,
          });

      if (!instrument.isIndex) stockResults.push(resultRow);
      // Indexes are contextual evidence, never ranked candidates (AGENTS.md).
      if (!instrument.isIndex && (resultRow.tier === "tier_a" || resultRow.tier === "tier_b")) {
        rankingInputs.push({
          instrumentId: instrument.instrumentId,
          direction: resultRow.direction,
          tier: resultRow.tier,
          score: resultRow.score ?? 0,
          componentScores,
        });
      }
    }

    if (budgetExceededCount > 0) {
      await logStage(
        supabase,
        runId,
        "time_budget",
        "warning",
        `${budgetExceededCount} instrument(s) skipped (marked unavailable) after the ${TIME_BUDGET_MS / 1000}s ingestion time budget was reached -- rerun to pick them up`
      );
    }

    const ranked = rankWithinTiers(rankingInputs);
    if (ranked.length > 0) {
      await supabase.from("rankings").insert(
        ranked.map((r) => ({
          run_id: runId,
          instrument_id: r.instrumentId,
          direction: r.direction,
          tier: r.tier,
          total_score: r.score,
          component_scores: r.componentScores,
          rank_within_tier: r.rankWithinTier,
        }))
      );
    }

    const coverage = reconcileCoverage(stockResults);
    await supabase.from("coverage_reconciliation").insert({ run_id: runId, ...coverage });

    // shared-gates.yaml: publish_when_false is false -- a run that doesn't
    // reconcile is marked partial, never completed, so Viewers (who only see
    // completed runs per RLS) never see an inconsistent ledger.
    await supabase
      .from("screening_runs")
      .update({
        status: coverage.reconciled ? "completed" : "partial",
        completed_at: new Date().toISOString(),
      })
      .eq("id", runId);

    await logStage(
      supabase,
      runId,
      "complete",
      coverage.reconciled ? "ok" : "warning",
      `unique_stock_count=${coverage.unique_stock_count} reconciled=${coverage.reconciled}`
    );
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    await logStage(supabase, runId, "error", "failed", message);
    await supabase
      .from("screening_runs")
      .update({ status: "failed", completed_at: new Date().toISOString() })
      .eq("id", runId);
  } finally {
    // Always release -- success, reconciliation failure, or a thrown error
    // all reach here. Without this, the lease would sit "active" until its
    // expires_at lapses (up to leaseDurationMs later) before another run
    // could start, even though this run is genuinely done.
    await releaseRunLease(supabase, RUN_TYPE);
  }
}

async function buildUniverse(supabase, runId, runDate) {
  const membership = new Map(); // instrumentId -> { symbol, name, indexIds: Set }

  for (const indexId of INDEX_IDS) {
    try {
      const { data: constituents } = await fetchIndexConstituents(indexId);
      for (const c of constituents) {
        if (!membership.has(c.instrumentId)) {
          membership.set(c.instrumentId, { symbol: c.symbol, name: c.name, indexIds: new Set() });
        }
        membership.get(c.instrumentId).indexIds.add(indexId);
      }
    } catch (err) {
      await logStage(supabase, runId, "universe", "warning", `${indexId} constituent fetch failed: ${err.message}`);
    }
  }

  const instrumentRows = [
    ...INDEX_IDS.map((id) => ({ id, symbol: id, name: id, exchange: "NSE", is_index: true })),
    ...[...membership.entries()].map(([id, m]) => ({
      id,
      symbol: m.symbol,
      name: m.name,
      exchange: "NSE",
      is_index: false,
    })),
  ];
  if (instrumentRows.length > 0) {
    await supabase.from("instruments").upsert(instrumentRows, { onConflict: "id" });
  }

  const membershipRows = [];
  for (const [instrumentId, m] of membership.entries()) {
    for (const indexId of m.indexIds) {
      membershipRows.push({
        index_id: indexId,
        instrument_id: instrumentId,
        effective_date: runDate,
        is_current: true,
      });
    }
  }
  if (membershipRows.length > 0) {
    await supabase
      .from("index_memberships")
      .upsert(membershipRows, { onConflict: "index_id,instrument_id,effective_date" });
  }

  return membership;
}

/** Cheap path used once TIME_BUDGET_MS is spent -- no Fyers call, just an honest terminal result so coverage stays complete. */
async function recordSkippedForTimeBudget({ supabase, runId, instrument }) {
  const resultRow = {
    run_id: runId,
    instrument_id: instrument.instrumentId,
    is_index: instrument.isIndex,
    terminal_state: "NO_DATA",
    tier: "unavailable",
    direction: null,
    score: null,
    failed_gates: [],
    data_quality: "NO_DATA",
  };
  await supabase.from("instrument_run_results").insert(resultRow);
  await supabase.from("data_quality_results").insert({
    run_id: runId,
    instrument_id: instrument.instrumentId,
    check_name: "ingestion",
    result: "NO_DATA",
    details: { note: "Skipped: run's ingestion time budget was already spent when this instrument's turn came up" },
  });
  return { resultRow, componentScores: {} };
}

async function evaluateInstrument({ supabase, runId, instrument, ruleDefinitions, parameterValues, ruleDirectionById }) {
  // SMM/PAPA/GUE all declare `scope: [index, equity]` at the strategy level
  // (strategies/*.yaml), so indexes run through the same OHLCV -> quality ->
  // rule-evaluation -> classify pipeline as stocks, using Fyers' index
  // symbols (providers/fyers.js). Indexes are still excluded from coverage
  // reconciliation and rankings below (AGENTS.md: "Index state is
  // contextual evidence and must never be copied into a member stock's own
  // result") -- they get a real terminal_state/tier for the index-analysis
  // page, they just never compete as a ranked candidate.
  let bars = [];
  let dataQuality = "NO_DATA";
  try {
    const ohlcv = await fetchOHLCV(instrument.instrumentId, instrument.symbol, OHLCV_LOOKBACK_DAYS, supabase);
    bars = ohlcv.data;
    const validation = validateBars(bars);
    dataQuality = validation.result;
    if (validation.issues.length > 0) {
      await supabase.from("data_quality_results").insert({
        run_id: runId,
        instrument_id: instrument.instrumentId,
        check_name: "bar_validation",
        result: dataQuality,
        details: { issues: validation.issues.slice(0, 20) },
      });
    }
  } catch (err) {
    await supabase.from("data_quality_results").insert({
      run_id: runId,
      instrument_id: instrument.instrumentId,
      check_name: "ingestion",
      result: "NO_DATA",
      details: { error: err instanceof Error ? err.message : String(err) },
    });
  }

  if (dataQuality !== "PASS") {
    const resultRow = {
      run_id: runId,
      instrument_id: instrument.instrumentId,
      is_index: instrument.isIndex,
      terminal_state: "NO_DATA",
      tier: "unavailable",
      direction: null,
      score: null,
      failed_gates: [],
      data_quality: dataQuality,
    };
    await supabase.from("instrument_run_results").insert(resultRow);
    return { resultRow, componentScores: {} };
  }

  // Migration 0006 widens market_bars_raw's uniqueness to
  // (instrument_id, interval, ts, provider) and adds interval/is_complete --
  // but code and migrations deploy independently, so this must keep working
  // against the schema as it exists *right now* (still the old
  // (instrument_id, session_date, provider) constraint, no interval column)
  // until that migration is actually applied. Try the new shape first;
  // fall back to the old one on any failure rather than losing every bar
  // for every instrument if the two are ever out of sync.
  const rawBarsNewShape = bars.map((b) => ({
    instrument_id: instrument.instrumentId,
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
  }));
  const { error: rawBarsNewShapeError } = await supabase
    .from("market_bars_raw")
    .upsert(rawBarsNewShape, { onConflict: "instrument_id,interval,ts,provider" });
  if (rawBarsNewShapeError) {
    const rawBarsOldShape = bars.map((b) => ({
      instrument_id: instrument.instrumentId,
      session_date: b.date,
      ts: `${b.date}T00:00:00+05:30`,
      open: b.open,
      high: b.high,
      low: b.low,
      close: b.close,
      volume: b.volume,
      provider: "fyers",
      freshness: "EOD",
    }));
    await supabase.from("market_bars_raw").upsert(rawBarsOldShape, { onConflict: "instrument_id,session_date,provider" });
  }

  // Adjusted bars (problem #20): raw + adjusted are stored separately, with
  // an explicit adjustment_version, rather than pivots/patterns ever running
  // on raw unadjusted data. No corporate-action data is ingested into this
  // project yet (corporate_actions stays empty), so this is a structural
  // no-op today -- computeAdjustedBars returns bars unchanged when there are
  // no qualifying actions -- but the storage path and versioning are real.
  try {
    const { data: corporateActions } = await supabase
      .from("corporate_actions")
      .select("action_type, ex_date, factor")
      .eq("instrument_id", instrument.instrumentId);
    const adjustedBars = computeAdjustedBars(bars, corporateActions ?? []);
    await supabase.from("market_bars_adjusted").upsert(
      adjustedBars.map((b) => ({
        instrument_id: instrument.instrumentId,
        interval: "1d",
        session_date: b.date,
        ts: `${b.date}T00:00:00+05:30`,
        open: b.open,
        high: b.high,
        low: b.low,
        close: b.close,
        volume: b.volume,
        adjustment_version: ADJUSTMENT_VERSION,
        is_complete: true,
      })),
      { onConflict: "instrument_id,interval,ts,adjustment_version" }
    );
  } catch (err) {
    // market_bars_adjusted doesn't exist until migration 0006 is applied --
    // never fail the instrument's actual screening result over this.
    await logStage(
      supabase,
      runId,
      "adjusted_bars",
      "warning",
      `${instrument.instrumentId}: adjusted-bar storage failed (likely migration 0006 not yet applied): ${err instanceof Error ? err.message : String(err)}`
    );
  }

  // Direction feature (Dow-theory pivots + best-effort wave label + chart)
  // is supplementary to the rule pipeline below -- a failure here must never
  // fail the instrument's actual screening result.
  try {
    await upsertDirectionAnalysis({ supabase, runId, instrument, bars, documentedParams: parameterValues.documented ?? {} });
  } catch (err) {
    await logStage(
      supabase,
      runId,
      "direction_chart",
      "warning",
      `${instrument.instrumentId}: direction analysis failed: ${err instanceof Error ? err.message : String(err)}`
    );
  }

  const context = buildFeatureContext(bars, parameterValues.documented ?? {});
  const { traces, failedGates } = evaluateRules(ruleDefinitions, context, parameterValues);

  if (traces.length > 0) {
    await supabase
      .from("rule_traces")
      .insert(traces.map((t) => ({ run_id: runId, instrument_id: instrument.instrumentId, ...t })));
  }

  const { terminalState, tier } = classify(traces, failedGates, dataQuality);
  const tracesByFramework = groupBy(traces, (t) => t.rule_id.split("-")[0]);
  const { total, componentScores } = scoreComponents(tracesByFramework);
  const direction = inferDirection(traces, ruleDirectionById);

  const resultRow = {
    run_id: runId,
    instrument_id: instrument.instrumentId,
    is_index: instrument.isIndex,
    terminal_state: terminalState,
    tier,
    direction,
    score: total,
    failed_gates: failedGates,
    data_quality: dataQuality,
  };
  await supabase.from("instrument_run_results").insert(resultRow);

  return { resultRow, componentScores };
}

/**
 * Renders/uploads a chart and upserts its instrument_direction row for each
 * timeframe whose pivot+latest-bar hash changed since the last run -- an
 * unchanged hash means the chart and row are left exactly as they are (the
 * feature's own "keep the same image if nothing changed" requirement).
 * NO_DATA instruments never reach this function, so their last-known-good
 * chart is preserved by simply never being touched.
 */
async function upsertDirectionAnalysis({ supabase, runId, instrument, bars, documentedParams }) {
  const analysis = await buildDirectionAnalysis(bars, documentedParams);

  const { data: existingRows } = await supabase
    .from("instrument_direction")
    .select("timeframe, input_hash")
    .eq("instrument_id", instrument.instrumentId);
  const existingHashByTimeframe = Object.fromEntries((existingRows ?? []).map((r) => [r.timeframe, r.input_hash]));

  for (const timeframe of DIRECTION_TIMEFRAMES) {
    const tf = analysis[timeframe];
    if (!tf) continue; // unresolved zigzag parameter or not enough bars -- never fabricated

    const objectPath = `${instrument.instrumentId}/${timeframe}.svg`;
    const unchanged = existingHashByTimeframe[timeframe] === tf.inputHash;

    if (!unchanged) {
      const svg = renderChartSvg({
        symbol: instrument.symbol,
        timeframe,
        bars: tf.bars,
        pivots: tf.pivots,
        unconfirmedLeg: tf.unconfirmedLeg,
        wave: tf.wave,
        dowState: tf.dowState,
      });
      const { error: uploadError } = await supabase.storage
        .from("direction-charts")
        .upload(objectPath, new Blob([svg], { type: "image/svg+xml" }), { contentType: "image/svg+xml", upsert: true });
      if (uploadError) {
        await logStage(supabase, runId, "direction_chart", "warning", `${instrument.instrumentId}/${timeframe}: chart upload failed: ${uploadError.message}`);
        continue; // don't point instrument_direction at a chart that isn't actually there
      }
    }

    await supabase.from("instrument_direction").upsert(
      {
        instrument_id: instrument.instrumentId,
        timeframe,
        run_id: runId,
        dow_state: tf.dowState,
        pivots: tf.pivots,
        last_swing_high: tf.lastSwingHigh,
        last_swing_low: tf.lastSwingLow,
        wave_label: tf.wave.label,
        wave_confidence: tf.wave.confidence,
        chart_object_path: objectPath,
        input_hash: tf.inputHash,
        data_quality: "PASS",
        updated_at: new Date().toISOString(),
      },
      { onConflict: "instrument_id,timeframe" }
    );

    // Pattern detection is fresh evidence for this run, not a derived cache
    // keyed off the direction hash -- a candlestick/double-extreme pattern
    // can newly qualify even when the underlying pivot structure hasn't
    // changed (e.g. one more bar closes the engulfing pair). Failure here
    // must never block the direction row above, which is why it's a
    // separate try/catch per timeframe rather than folded into the block
    // above.
    try {
      await persistPatternDetections({ supabase, runId, instrument, timeframe, bars: tf.bars, pivots: tf.pivots });
    } catch (err) {
      await logStage(
        supabase,
        runId,
        "pattern_detection",
        "warning",
        `${instrument.instrumentId}/${timeframe}: pattern detection failed (likely migration 0006 not yet applied): ${err instanceof Error ? err.message : String(err)}`
      );
    }
  }
}

/**
 * Runs the implemented candlestick + double-extreme pattern detectors for
 * one instrument/timeframe and inserts the results into pattern_detections
 * (migration 0006, not yet applied -- degrades gracefully like the other
 * new-schema writes in this file). Deliberately an INSERT, not an upsert:
 * pattern_detections is immutable per-run evidence, not a latest-state row
 * like instrument_direction above -- a pattern observed in an earlier run
 * and never re-detected simply stops appearing in later runs' evidence
 * rather than being overwritten.
 */
async function persistPatternDetections({ supabase, runId, instrument, timeframe, bars, pivots }) {
  const candlestickHits = detectCandlestickPatterns(bars);
  const doubleExtremeHits = detectDoubleExtremePatterns(pivots, bars);
  const hits = [...candlestickHits, ...doubleExtremeHits];
  if (hits.length === 0) return;

  const rows = hits.map((hit) => ({
    run_id: runId,
    instrument_id: instrument.instrumentId,
    timeframe,
    pattern_name: hit.patternName,
    direction: hit.direction,
    state: hit.state,
    anchor_points: hit.anchorPoints,
    neckline_or_boundary: hit.necklineOrBoundary ?? null,
    trigger_bar_ts: hit.triggerBarDate,
    target_price: hit.targetPrice,
    invalidation_price: hit.invalidationPrice,
    volume_evidence: hit.volumeEvidence,
    source_locator: `${hit.sourceLocator} (pattern-param-version ${PATTERN_PARAM_VERSION})`,
    computed_at: new Date().toISOString(),
  }));

  const { error } = await supabase.from("pattern_detections").insert(rows);
  if (error && error.code !== "PGRST205") throw error;
}

/** Majority vote of PASSed bullish vs. bearish rules. Ties/no signal are undirected, not guessed. */
function inferDirection(traces, ruleDirectionById) {
  let bullish = 0;
  let bearish = 0;
  for (const t of traces) {
    if (t.result !== "PASS") continue;
    const dir = ruleDirectionById[t.rule_id];
    if (dir === "bullish") bullish++;
    else if (dir === "bearish") bearish++;
  }
  if (bullish > bearish) return "bullish";
  if (bearish > bullish) return "bearish";
  return null;
}

function flattenParameters(values) {
  return {
    ...(values.documented ?? {}),
    ...(values.project_defaults_requiring_backtest ?? {}),
    documented: values.documented ?? {},
  };
}

function groupBy(arr, keyFn) {
  const out = {};
  for (const item of arr) {
    const key = keyFn(item);
    (out[key] ??= []).push(item);
  }
  return out;
}

async function logStage(supabase, runId, stage, status, message) {
  await supabase.from("pipeline_audit_log").insert({ run_id: runId, stage, status, message });
}

function json(body, status = 200) {
  return new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });
}

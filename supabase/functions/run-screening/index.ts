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
import { fetchOHLCV, fetchHourlyOHLCV } from "./providers/fyers.js";
import { validateBars } from "./quality.js";
import { buildFeatureContext } from "./features/context.js";
import { buildDirectionAnalysis, ALGORITHM_VERSION as DIRECTION_ALGORITHM_VERSION } from "./features/direction.js";
import { detectCandlestickPatterns, detectDoubleExtremePatterns, PATTERN_PARAM_VERSION } from "./features/patterns.js";
import { computeFinalAlignment } from "./features/alignment.js";
import { evaluateSwingHypothesis, directionLockPassed } from "./features/swing-analysis.js";
import { detectWave3Ignition, detectWave2Pullback } from "./features/hourly-routes.js";
import { computeAdjustedBars, ADJUSTMENT_VERSION } from "./features/corporate-actions.js";
import { renderChartSvg, RENDER_VERSION } from "./charts/render.js";
import { evaluateRules } from "./rules/evaluate.js";
import { classify, scoreComponents, rankWithinTiers } from "./rank.js";
import { reconcileCoverage } from "./reconcile.js";
import { acquireRunLease, heartbeatRunLease, releaseRunLease } from "./run-lease.js";
import { latestCompletedNseSession, normalizeHourlyBars } from "./nse-calendar.js";

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

    // Once the clock crosses TIME_BUDGET_MS for one instrument, it has
    // crossed it for every instrument after it too (time only moves
    // forward) -- so there is no need to keep re-checking Date.now() and
    // recording each remaining instrument's "skipped" result with its own
    // two sequential awaited inserts. That per-instrument insert pair was
    // itself slow enough (real network round trips, not the near-zero
    // latency the mocked-client unit tests see) that on a run with ~490
    // instruments left to skip, doing them one at a time could by itself
    // run past the platform's own wall-clock kill -- leaving the run stuck
    // in "running" forever with the pipeline hard-killed mid-loop (confirmed
    // live on 2026-09-10: a run died at ~150s wall clock having only
    // recorded 41 results, most of them still-sequential "skipped" rows).
    // Breaking out and bulk-inserting the remainder in two calls instead of
    // ~2*N fixes that.
    let cutoffIndex = allInstruments.length;
    for (const [index, instrument] of allInstruments.entries()) {
      if (index > 0 && index % HEARTBEAT_EVERY_N_INSTRUMENTS === 0) {
        await heartbeatRunLease(supabase, RUN_TYPE);
      }

      if (Date.now() - startedAtMs > TIME_BUDGET_MS) {
        cutoffIndex = index;
        break;
      }

      const { resultRow, componentScores } = await evaluateInstrument({
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

    const skippedInstruments = allInstruments.slice(cutoffIndex);
    if (skippedInstruments.length > 0) {
      const skippedResultRows = await recordSkippedForTimeBudgetBulk({ supabase, runId, instruments: skippedInstruments });
      for (const resultRow of skippedResultRows) {
        if (!resultRow.is_index) stockResults.push(resultRow);
        // Every bulk-skipped row is tier "unavailable" -- never tier_a/b, so
        // none of these ever belong in rankingInputs.
      }
      await logStage(
        supabase,
        runId,
        "time_budget",
        "warning",
        `${skippedInstruments.length} instrument(s) skipped (marked unavailable) after the ${TIME_BUDGET_MS / 1000}s ingestion time budget was reached -- rerun to pick them up`
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

/**
 * Cheap path used once TIME_BUDGET_MS is spent -- no Fyers calls, just
 * honest terminal results for every remaining instrument so coverage stays
 * complete. Bulk-inserted (two round trips total, not two per instrument) --
 * see the comment above this function's only call site for why that matters.
 */
async function recordSkippedForTimeBudgetBulk({ supabase, runId, instruments }) {
  const resultRows = instruments.map((instrument) => ({
    run_id: runId,
    instrument_id: instrument.instrumentId,
    is_index: instrument.isIndex,
    terminal_state: "NO_DATA",
    tier: "unavailable",
    direction: null,
    score: null,
    failed_gates: [],
    data_quality: "NO_DATA",
  }));
  const qualityRows = instruments.map((instrument) => ({
    run_id: runId,
    instrument_id: instrument.instrumentId,
    check_name: "ingestion",
    result: "NO_DATA",
    details: { note: "Skipped: run's ingestion time budget was already spent when this instrument's turn came up" },
  }));
  await supabase.from("instrument_run_results").insert(resultRows);
  await supabase.from("data_quality_results").insert(qualityRows);
  return resultRows;
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
  // Raw-bar storage (with its old-shape fallback) and adjusted-bar storage
  // write to two different tables from the same already-fetched `bars` --
  // neither reads the other's result, so they run concurrently rather than
  // one blocking the other's network round trip.
  await Promise.all([
    (async () => {
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
    })(),
    (async () => {
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
    })(),
  ]);

  // Direction analysis (Dow-theory pivots + wave label + chart, writing
  // instrument_direction/instrument_direction_runs/direction_pivots/
  // elliott_hypotheses/pattern_detections/instrument_alignment) and rule
  // evaluation (writing rule_traces) both only need `bars` -- neither reads
  // the other's output, so there is no reason to make one wait on the
  // other's network round trips. Direction analysis is still supplementary
  // to the rule pipeline (a failure there must never fail the instrument's
  // actual screening result), so it keeps its own try/catch inside this
  // concurrent branch rather than being allowed to reject the Promise.all.
  const [, { traces, failedGates }] = await Promise.all([
    (async () => {
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
    })(),
    (async () => {
      const context = buildFeatureContext(bars, parameterValues.documented ?? {});
      const result = evaluateRules(ruleDefinitions, context, parameterValues);
      if (result.traces.length > 0) {
        await supabase
          .from("rule_traces")
          .insert(result.traces.map((t) => ({ run_id: runId, instrument_id: instrument.instrumentId, ...t })));
      }
      return result;
    })(),
  ]);

  // 1-hour bar ingestion + route detection (Phase 2/4, now started): both
  // swing playbooks state "M1 AND M2 AND M3 AND M4 must all pass before the
  // hourly chart is opened" -- so this only spends Fyers request budget on
  // an instrument once its weekly+daily direction lock has actually
  // cleared, rather than fetching hourly data for all ~500 instruments
  // every run (which the existing 125s time budget and rate limits could
  // not absorb -- see providers/fyers.js's own rate-limit comments). Real
  // effect is a no-op today: buy-swing.yaml/sell-swing.yaml aren't seeded
  // yet, so directionLockPassed is always false until they are.
  const bullishQualifiesForHourly = directionLockPassed("bullish", traces);
  const bearishQualifiesForHourly = directionLockPassed("bearish", traces);
  let routeEvidence = null;
  if (bullishQualifiesForHourly || bearishQualifiesForHourly) {
    try {
      routeEvidence = await ingestHourlyBarsAndDetectRoutes({
        supabase,
        instrument,
        dailyBars: bars,
        parameterValues: parameterValues.documented ?? {},
        bullishQualifiesForHourly,
        bearishQualifiesForHourly,
      });
    } catch (err) {
      await logStage(
        supabase,
        runId,
        "hourly_ingest",
        "warning",
        `${instrument.instrumentId}: hourly bar ingestion/route detection failed: ${err instanceof Error ? err.message : String(err)}`
      );
    }
  }

  // Swing (Weekly->Daily->1H) mandatory-gate synthesis -- bullish and
  // bearish are always separate rows (problem #15). A no-op until
  // strategies/buy-swing.yaml/sell-swing.yaml are seeded (not yet, per this
  // task's no-remote-writes constraint) -- evaluateSwingHypothesis returns
  // null when neither hypothesis has any WBP-/WSP- traces to work with.
  // Failure here must never block instrument_run_results below.
  try {
    await persistSwingAnalysisResults({ supabase, runId, instrument, traces, routeEvidence });
  } catch (err) {
    await logStage(
      supabase,
      runId,
      "swing_analysis",
      "warning",
      `${instrument.instrumentId}: swing analysis persistence failed (likely migration 0006 not yet applied): ${err instanceof Error ? err.message : String(err)}`
    );
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
 * Persists evaluateSwingHypothesis's bullish and bearish results (when
 * present) into swing_analysis_results, plus each hypothesis's own gate
 * traces into swing_analysis_rule_traces -- migration 0006, not yet applied,
 * degrades gracefully. swing_analysis_results is upserted per
 * (run_id, instrument_id, hypothesis) since a run only ever evaluates an
 * instrument once; swing_analysis_rule_traces is delete-then-insert under
 * that result's id so a re-run within the same run_id (should not happen in
 * normal operation, but is not assumed) never leaves stale duplicate traces.
 */
async function persistSwingAnalysisResults({ supabase, runId, instrument, traces, routeEvidence }) {
  for (const hypothesis of ["bullish", "bearish"]) {
    const analysis = evaluateSwingHypothesis(hypothesis, traces);
    if (!analysis) continue; // no WBP-/WSP- gates evaluated this run -- strategy not seeded/active yet

    // Route evidence (features/hourly-routes.js -- BUY-1/SELL-3 and
    // BUY-4/SELL-4 so far, see that file's own scope note for the rest) is
    // supplementary, never authoritative on its own: WBP-M5/WSP-S5 requires
    // ruling in/out all 5 routes, not just the ones implemented, so finding
    // a fully-confirmed setup still doesn't flip final_action away from
    // WAIT -- it's disclosed in pending_conditions instead, alongside the
    // still-missing M6-M8. A wave hypothesis can only be in one Elliott
    // position at a time, so at most one detector should match today, but
    // this handles routeEvidence as an array (0, 1, or more matches) rather
    // than assuming that stays true as more routes are added.
    const routes = routeEvidence?.[hypothesis] ?? [];
    const passingRoute = routes.find((r) => r.requiredChecksPassed);
    if (passingRoute) {
      analysis.selectedRoute = passingRoute.route;
    }
    for (const r of routes) {
      analysis.pendingConditions.push(
        r.requiredChecksPassed
          ? `${r.route}'s required checks all pass -- WAIT still stands: WBP-M5/WSP-S5 requires checking all 5 routes, not just this one, and M6-M8 remain unautomated`
          : `${r.route} detected (${r.state}) but its required checks are not all confirmed yet -- see route_evidence`
      );
    }

    const { data: resultRow, error: resultError } = await supabase
      .from("swing_analysis_results")
      .upsert(
        {
          run_id: runId,
          instrument_id: instrument.instrumentId,
          hypothesis,
          selected_route: analysis.selectedRoute,
          mandatory_gates: analysis.mandatoryGates,
          route_evidence: routes.length > 0 ? routes : null,
          confirmation_groups: analysis.confirmationGroups,
          confirmation_groups_passed: analysis.confirmationGroupsPassed,
          vetoes: analysis.vetoes,
          pending_conditions: analysis.pendingConditions,
          entry_price: analysis.entryPrice,
          structural_stop: analysis.structuralStop,
          conservative_target: analysis.conservativeTarget,
          risk: analysis.risk,
          reward: analysis.reward,
          reward_risk_ratio: analysis.rewardRiskRatio,
          final_action: analysis.finalAction,
          data_quality: analysis.dataQuality,
          computed_at: new Date().toISOString(),
        },
        { onConflict: "run_id,instrument_id,hypothesis" }
      )
      .select("id")
      .single();

    if (resultError) {
      if (resultError.code === "PGRST205") return; // table not migrated yet -- rule_traces below would fail identically
      throw resultError;
    }

    const gatePrefix = hypothesis === "bullish" ? "WBP-" : "WSP-";
    const gateTraces = traces.filter((t) => t.rule_id.startsWith(gatePrefix));

    await supabase.from("swing_analysis_rule_traces").delete().eq("analysis_result_id", resultRow.id);
    if (gateTraces.length > 0) {
      const { error: traceError } = await supabase.from("swing_analysis_rule_traces").insert(
        gateTraces.map((t) => ({
          analysis_result_id: resultRow.id,
          rule_id: t.rule_id,
          group_name: null,
          result: t.result,
          observed_values: t.observed_values,
          thresholds: t.thresholds,
          explanation: t.explanation,
          source_locator: t.source_locator,
        }))
      );
      if (traceError) throw traceError;
    }
  }
}

/**
 * Fetches the trailing ~30 days of 1-hour bars (providers/fyers.js's
 * fetchHourlyOHLCV), upserts them into market_bars_raw with interval='1h'
 * (migration 0006, not yet applied), then runs every implemented hourly
 * route detector (features/hourly-routes.js: detectWave3Ignition and
 * detectWave2Pullback so far) against whichever hypothesis actually
 * qualified (bullishQualifiesForHourly/bearishQualifiesForHourly, from
 * directionLockPassed()). A wave hypothesis can only be in one Elliott
 * position at a time, so in practice at most one detector matches per
 * hypothesis today -- but this collects an array rather than assuming
 * that stays true as more routes are added.
 *
 * Unlike the daily bars write, there is NO safe old-schema fallback here:
 * the pre-migration unique constraint is (instrument_id, session_date,
 * provider), which an hourly bar would collide under with that same day's
 * DAILY bar (both share the same session_date) -- attempting an old-shape
 * write would silently corrupt the daily row. So this only ever attempts
 * the new shape; if it fails (table/columns don't exist yet), the caller's
 * try/catch logs a warning and this run simply has no hourly data or route
 * evidence for the instrument, same as any other NO_DATA outcome -- never a
 * corrupted daily bar.
 *
 * @returns {{bullish: object[], bearish: object[]}|null} every matching route
 *   detector's result per hypothesis (only for the hypothesis(es) that
 *   qualified), or null if there were no hourly bars to work with (or the
 *   required zigzag_hourly_pct/dailyZigzagPct/hour_slot_volume_lookback_sessions
 *   parameters are unresolved -- never guessed)
 */
async function ingestHourlyBarsAndDetectRoutes({ supabase, instrument, dailyBars, parameterValues, bullishQualifiesForHourly, bearishQualifiesForHourly }) {
  const { data: rawCandles } = await fetchHourlyOHLCV(instrument.instrumentId, instrument.symbol, supabase);
  const hourlyBars = normalizeHourlyBars(rawCandles);
  if (hourlyBars.length === 0) return null;

  const rows = hourlyBars.map((b) => ({
    instrument_id: instrument.instrumentId,
    interval: "1h",
    session_date: b.sessionDate,
    ts: b.ts,
    open: b.open,
    high: b.high,
    low: b.low,
    close: b.close,
    volume: b.volume,
    provider: "fyers",
    freshness: "INTRADAY",
    is_complete: b.isComplete,
  }));
  const { error } = await supabase.from("market_bars_raw").upsert(rows, { onConflict: "instrument_id,interval,ts,provider" });
  if (error) throw error;

  const hourlyZigzagPct = parameterValues.zigzag_hourly_pct;
  const dailyZigzagPct = parameterValues.zigzag_daily_pct;
  const hourSlotVolumeLookbackSessions = parameterValues.hour_slot_volume_lookback_sessions;
  if (hourlyZigzagPct == null || dailyZigzagPct == null || hourSlotVolumeLookbackSessions == null) return null;

  const detectAll = (bullish) =>
    [
      detectWave3Ignition({ hourlyBars, dailyBars, bullish, hourlyZigzagPct, dailyZigzagPct, hourSlotVolumeLookbackSessions }),
      detectWave2Pullback({ hourlyBars, bullish, hourlyZigzagPct }),
    ].filter(Boolean);

  return {
    bullish: bullishQualifiesForHourly ? detectAll(true) : [],
    bearish: bearishQualifiesForHourly ? detectAll(false) : [],
  };
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

  // Each timeframe's chart/direction/pattern work below is fully
  // independent of every other timeframe's -- nothing reads another
  // timeframe's result until persistFinalAlignment, which needs all three
  // at once. Running them sequentially was a layout accident, not a real
  // dependency, and those per-timeframe network round trips (chart upload +
  // up to 4 more table writes each) were the dominant cost of evaluating one
  // instrument -- confirmed live on 2026-09-10: a run averaged ~9-14s per
  // instrument against a 125s budget, covering only ~13 of 501 stocks.
  // Running the three timeframes concurrently instead of one after another
  // cuts this section's wall-clock time roughly 3x with no behavior change.
  const perTimeframeResults = await Promise.all(
    DIRECTION_TIMEFRAMES.map(async (timeframe) => {
      const tf = analysis[timeframe];
      if (!tf) return null; // unresolved zigzag parameter or not enough bars -- never fabricated

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
          return null; // don't point instrument_direction at a chart that isn't actually there
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

      // Run-scoped schema (migration 0006, not yet applied -- degrades
      // gracefully): instrument_direction above is latest-state only and gets
      // overwritten every run, so it can never answer "what did we actually
      // see on run X" -- these tables are this run's immutable evidence.
      // Failure here must never block the legacy row above (still what the
      // live Direction page reads) or pattern detection below.
      try {
        await persistDirectionRun({ supabase, runId, instrument, timeframe, tf, objectPath });
      } catch (err) {
        await logStage(
          supabase,
          runId,
          "direction_run",
          "warning",
          `${instrument.instrumentId}/${timeframe}: run-scoped direction/wave persistence failed (likely migration 0006 not yet applied): ${err instanceof Error ? err.message : String(err)}`
        );
      }

      // Pattern detection is computed regardless of persistence success (the
      // in-memory hits still feed final_alignment below even if the insert
      // degrades because migration 0006 isn't applied). It's also fresh
      // evidence for this run, not a derived cache keyed off the direction
      // hash -- a candlestick/double-extreme pattern can newly qualify even
      // when the underlying pivot structure hasn't changed (e.g. one more bar
      // closes the engulfing pair). A persistence failure must never block the
      // direction row above, which is why it's a separate try/catch per
      // timeframe rather than folded into the block above.
      const hits = [...detectCandlestickPatterns(tf.bars), ...detectDoubleExtremePatterns(tf.pivots, tf.bars)];
      let patterns = hits;
      try {
        patterns = await persistPatternDetections({ supabase, runId, instrument, timeframe, hits });
      } catch (err) {
        // persistence failed -- hits are still usable for alignment, just without a DB id per hit
        await logStage(
          supabase,
          runId,
          "pattern_detection",
          "warning",
          `${instrument.instrumentId}/${timeframe}: pattern detection persistence failed (likely migration 0006 not yet applied): ${err instanceof Error ? err.message : String(err)}`
        );
      }

      return [timeframe, patterns];
    })
  );

  const patternsByTimeframe = Object.fromEntries(perTimeframeResults.filter(Boolean));

  // final_alignment (#1, #6): combines SMM (all 3 timeframes' dow_state),
  // GUE (disclosed but non-authoritative, see alignment.js), and PAPA
  // (a TRIGGERED opposing pattern downgrades to MANUAL_REVIEW) into one
  // server-side call -- never derived in the browser from raw dow_state
  // strings again.
  try {
    await persistFinalAlignment({ supabase, runId, instrument, analysis, patternsByTimeframe });
  } catch (err) {
    await logStage(
      supabase,
      runId,
      "final_alignment",
      "warning",
      `${instrument.instrumentId}: final_alignment computation/persistence failed (likely migration 0006 not yet applied): ${err instanceof Error ? err.message : String(err)}`
    );
  }
}

/**
 * Persists one timeframe's direction/wave analysis into the new run-scoped
 * schema: instrument_direction_runs (this run's own snapshot, unlike the
 * latest-state instrument_direction table above), direction_pivots (the
 * confirmed swing sequence, one row each), and elliott_hypotheses (primary +
 * alternative, when a structured hypothesis actually exists).
 *
 * trend_defining_level/invalidation_level: smm-chart-analysis-SKILL.md names
 * "the last HL in an uptrend (or last LH in a downtrend)" as THE
 * trend-defining level, and separately describes invalidation for a bullish
 * view as a close below that same level -- the source itself treats these as
 * the same number for an intact/confirmed trend, which is why both columns
 * get lastSwingLow/lastSwingHigh here. confirmation_trigger is left null:
 * no document in this project defines a deterministic confirmation-trigger
 * level (it's a live example in the source -- "weekly close above 24,800" --
 * not a formula), so computing one would mean inventing it.
 */
async function persistDirectionRun({ supabase, runId, instrument, timeframe, tf, objectPath }) {
  const directionalLevel = trendDefiningLevelFor(tf.dowState, tf.lastSwingHigh, tf.lastSwingLow);

  const { error: runError } = await supabase.from("instrument_direction_runs").upsert(
    {
      run_id: runId,
      instrument_id: instrument.instrumentId,
      timeframe,
      dow_state: tf.dowState,
      confirmed_pivots: tf.pivots,
      unconfirmed_leg: tf.unconfirmedLeg,
      trend_defining_level: directionalLevel,
      confirmation_trigger: null,
      invalidation_level: directionalLevel,
      chart_object_path: objectPath,
      chart_input_hash: tf.inputHash,
      chart_algorithm_version: DIRECTION_ALGORITHM_VERSION,
      chart_renderer_version: RENDER_VERSION,
      data_quality: "PASS",
      computed_at: new Date().toISOString(),
    },
    { onConflict: "run_id,instrument_id,timeframe" }
  );
  if (runError) {
    if (runError.code !== "PGRST205") throw runError;
    return; // table not migrated yet -- pivots/hypotheses below would fail identically, skip them too
  }

  if (tf.pivots.length > 0) {
    // Confirmed pivots only -- the unconfirmed leg has no honest HH/HL/LH/LL/
    // EH/EL label yet (that's what makes it unconfirmed), so it stays in
    // instrument_direction_runs.unconfirmed_leg above rather than being
    // force-fit into this table's label enum.
    const pivotRows = tf.pivots.map((p, i) => ({
      run_id: runId,
      instrument_id: instrument.instrumentId,
      timeframe,
      label: p.type,
      price: p.price,
      bar_date: p.date,
      confidence: "confirmed",
      sequence_index: i,
    }));
    const { error: pivotError } = await supabase.from("direction_pivots").insert(pivotRows);
    if (pivotError && pivotError.code !== "PGRST205") throw pivotError;
  }

  const hypotheses = [
    tf.wave?.structureType ? { rank: "primary", wave: tf.wave } : null,
    tf.waveAlternative?.structureType ? { rank: "alternative", wave: tf.waveAlternative } : null,
  ].filter(Boolean);
  if (hypotheses.length > 0) {
    const hypothesisRows = hypotheses.map(({ rank, wave }) => ({
      run_id: runId,
      instrument_id: instrument.instrumentId,
      timeframe,
      rank,
      structure_type: wave.structureType,
      current_wave: wave.currentWave,
      wave_state: wave.waveState,
      rule_arithmetic: wave.ruleArithmetic,
      confidence: wave.confidence,
      invalidation_price: wave.invalidationPrice,
      invalidation_condition: wave.invalidationCondition,
      source_locator: wave.structureType === "impulse" ? "strategies/gue.yaml GUE-IMPULSE-001/002/003" : "features/wave.js tryCorrectiveProgress (zigzag shape check)",
      computed_at: new Date().toISOString(),
    }));
    const { error: waveError } = await supabase.from("elliott_hypotheses").insert(hypothesisRows);
    if (waveError && waveError.code !== "PGRST205") throw waveError;
  }
}

function trendDefiningLevelFor(dowState, lastSwingHigh, lastSwingLow) {
  if (dowState === "uptrend_intact" || dowState === "confirmed_reversal_bullish") return lastSwingLow;
  if (dowState === "downtrend_intact" || dowState === "confirmed_reversal_bearish") return lastSwingHigh;
  return null; // sideways/ambiguous -- no single directional level to name without picking a side
}

/**
 * Runs the implemented candlestick + double-extreme pattern detectors'
 * results through an insert into pattern_detections (migration 0006, not
 * yet applied -- degrades gracefully like the other new-schema writes in
 * this file, but still returns the computed hits either way so alignment
 * computation always has real pattern evidence to work with). Deliberately
 * an INSERT, not an upsert: pattern_detections is immutable per-run
 * evidence, not a latest-state row like instrument_direction above -- a
 * pattern observed in an earlier run and never re-detected simply stops
 * appearing in later runs' evidence rather than being overwritten.
 * @returns {object[]} the hits, each carrying a real `id` from the insert
 *   when persistence succeeded (needed to set instrument_alignment's
 *   triggered_*_pattern_id honestly rather than guessing one)
 */
async function persistPatternDetections({ supabase, runId, instrument, timeframe, hits }) {
  if (hits.length === 0) return hits;

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

  const { data: inserted, error } = await supabase.from("pattern_detections").insert(rows).select("id");
  if (error) {
    if (error.code === "PGRST205") return hits; // table not migrated yet -- hits are still usable in-memory
    throw error;
  }
  // A single multi-row INSERT's RETURNING rows come back in the same order
  // as the VALUES list on every Postgres version this project targets -- but
  // only rely on that when the count actually matches; otherwise leave hits
  // without a DB id rather than risk mis-attributing one.
  if (inserted && inserted.length === hits.length) {
    return hits.map((hit, i) => ({ ...hit, id: inserted[i].id }));
  }
  return hits;
}

/**
 * Computes final_alignment for one instrument (SMM+GUE+PAPA synthesis, see
 * alignment.js) and upserts it into instrument_alignment (migration 0006,
 * not yet applied -- degrades gracefully). monthly/weekly/daily_direction_id
 * and elliott_hypothesis_id are deliberately left null: they reference
 * instrument_direction_runs/elliott_hypotheses, which nothing in this
 * pipeline writes to yet (still REMAINING per architecture-plan.md) --
 * populating them now would mean inventing ids.
 */
async function persistFinalAlignment({ supabase, runId, instrument, analysis, patternsByTimeframe }) {
  const alignment = computeFinalAlignment(analysis, patternsByTimeframe);

  const bearishPatternId =
    alignment.opposingTriggeredPattern?.direction === "bearish" ? findPatternId(patternsByTimeframe, alignment.opposingTriggeredPattern) : null;
  const bullishPatternId =
    alignment.opposingTriggeredPattern?.direction === "bullish" ? findPatternId(patternsByTimeframe, alignment.opposingTriggeredPattern) : null;

  const { error } = await supabase.from("instrument_alignment").upsert(
    {
      run_id: runId,
      instrument_id: instrument.instrumentId,
      final_alignment: alignment.finalAlignment,
      triggered_bearish_pattern_id: bearishPatternId,
      triggered_bullish_pattern_id: bullishPatternId,
      computed_at: new Date().toISOString(),
    },
    { onConflict: "run_id,instrument_id" }
  );
  if (error && error.code !== "PGRST205") throw error;
}

function findPatternId(patternsByTimeframe, opposingPattern) {
  const hits = patternsByTimeframe[opposingPattern.timeframe] ?? [];
  const hit = hits.find((h) => h.patternName === opposingPattern.patternName && h.direction === opposingPattern.direction && h.state === "TRIGGERED");
  return hit?.id ?? null;
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

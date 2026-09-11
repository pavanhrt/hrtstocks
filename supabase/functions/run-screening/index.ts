// run-screening Edge Function -- the orchestrator described in
// references/technical-architecture.md's "Job sequence":
//   universe -> ingest -> validate -> features -> rule evaluation ->
//   ranking -> coverage reconciliation -> persist -> (publish only if
//   reconciled).
//
// Invoked by: the Next.js POST /api/screening-runs route (Researcher+ only,
// manual trigger), the eod-screening-recovery-sweep pg_cron job (migration
// 0008 -- resumes a stuck/interrupted run, never starts a new one), and this
// function's own self-chain continuation request (see the batch-claim loop
// below). All three call this URL with the project's secret key
// (SUPABASE_SECRET_KEYS' "default" entry) as a Bearer token, which is also
// this function's own auth check below.
//
// Durable pipeline (2026-09-11 rewrite): a run's ~501-instrument universe no
// longer has to fit inside one Edge Function invocation's wall-clock budget
// -- confirmed mathematically impossible on this project's free-tier plan
// (Fyers' rate limit alone needs a ~2.8 minute floor, longer than the
// platform's ~150s hard kill). Work is split into pipeline_batches rows
// (migration 0008): universe (build the universe, seed every other batch),
// incremental (this run's fresh daily bars for a chunk of instruments),
// backfill (one-time deeper history for instruments that have none stored
// yet), reconcile (ranking/coverage/final status, once every
// universe/incremental batch is resolved). Batches are claimed one at a
// time via the atomic claim_next_pipeline_batch() RPC (FOR UPDATE SKIP
// LOCKED). When an invocation's own TIME_BUDGET_MS is nearly spent, it
// releases the run's lease and fires a self-chain request (resume_run_id)
// to keep going in a fresh invocation; the recovery-sweep cron is the
// safety net if that self-chain never lands (hard kill, network blip).
//
// This closes the core dishonesty bug reported 2026-09-11: a run that only
// ever attempted 14 of 501 instruments (the rest bulk-inserted as a fake
// terminal NO_DATA once the old 125s time budget ran out) still rendered as
// COMPLETED, because reconcile.js's reconcileCoverage() only checks that
// whatever results *were* collected sum to a consistent tier count -- it
// has no notion of the expected universe size. The real completion gate is
// now pipeline/run-status.js's decideRunStatus(), which compares real
// results against the expected universe (the union of every incremental
// batch's own instrument list) before ever calling a run 'completed'.
//
// NOTE: written and unit-tested at the module level under Node (see the
// sibling *.test.js files, run via `npm test` from stock-platform/), but
// this entrypoint itself requires the Deno runtime (Deno.serve, npm: import
// specifiers).
//
// Data sources (as of 2026-09-07): index constituent lists come from NSE's
// static archive CSVs (providers/nse-archives.js); OHLCV comes from Fyers'
// licensed data API (providers/fyers.js).

import { createClient } from "npm:@supabase/supabase-js@2";
import { fetchIndexConstituents } from "./providers/nse-archives.js";
import { fetchOHLCVRange, fetchHourlyOHLCV, nextIncrementalRange } from "./providers/fyers.js";
import { validateBars } from "./quality.js";
import { buildFeatureContext } from "./features/context.js";
import { buildDirectionAnalysis, ALGORITHM_VERSION as DIRECTION_ALGORITHM_VERSION } from "./features/direction.js";
import { detectCandlestickPatterns, detectDoubleExtremePatterns, PATTERN_PARAM_VERSION } from "./features/patterns.js";
import { computeFinalAlignment } from "./features/alignment.js";
import { evaluateSwingHypothesis, directionLockPassed } from "./features/swing-analysis.js";
import { detectWave3Ignition, detectWave2Pullback, detectWave5Exhaustion } from "./features/hourly-routes.js";
import { evaluateHourlyAdxCondition } from "./features/hourly-conditions.js";
import { zigzagPivots, classifyDowStructure, aggregateBars } from "./features/structure.js";
import { macdHistogramPhase } from "./features/indicators.js";
import { detectTriggeredPapaFormations } from "./features/papa-formations.js";
import { evaluateSmmHat } from "./features/smm-hat.js";
import { computeRewardRisk } from "./features/reward-risk.js";
import { evaluateConfirmationGroups } from "./features/confirmation-groups.js";
import { evaluateSwingVetoes } from "./features/swing-vetoes.js";
import { computeAdjustedBars, ADJUSTMENT_VERSION } from "./features/corporate-actions.js";
import { renderChartSvg, RENDER_VERSION } from "./charts/render.js";
import { evaluateRules } from "./rules/evaluate.js";
import { classify, scoreComponents, rankWithinTiers } from "./rank.js";
import { reconcileCoverage } from "./reconcile.js";
import { acquireRunLease, heartbeatRunLease, releaseRunLease } from "./run-lease.js";
import { latestCompletedNseSession, normalizeHourlyBars } from "./nse-calendar.js";
import { seededShuffle } from "./pipeline/shuffle.js";
import { buildChunks, CHUNK_SIZE, BACKFILL_CHUNK_SIZE } from "./pipeline/chunks.js";
import { decideRunStatus } from "./pipeline/run-status.js";

const DIRECTION_TIMEFRAMES = ["daily", "weekly", "monthly"];
const RUN_TYPE = "eod_screening";
// Shortened from run-lease.js's own default (10 min) specifically for this
// run type: a healthy ~60-instrument chunk finishes in well under a minute,
// so 3 minutes is ~2x margin -- cuts dead-invocation detection from up to
// 10-11 minutes down to ~4 (this lease timeout + one recovery-sweep cron
// interval).
const LEASE_DURATION_MS = 3 * 60 * 1000;

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
// bars, so ~250 trading days in a year is comfortably enough). Used as the
// first-ever-fetch fallback window in nextIncrementalRange, and as the
// analysis window re-read from storage after an incremental fetch.
const OHLCV_LOOKBACK_DAYS = 365;
// PROJECT_DEFAULT -- no source document specifies an exact bar/year count
// for "Primary-degree Elliott" or monthly structure validation. Sanity-
// checked against MACD's own documented ~35-monthly-bar (~3 year) warm-up
// (docs/swing-strategy-extraction.md) with real margin to spare.
const BACKFILL_TARGET_DAYS = 5 * 365;
const BACKFILL_LEG_DAYS = 366; // Fyers' own single-request cap for daily/weekly/monthly resolutions
const MAX_BACKFILL_LEGS = Math.ceil(BACKFILL_TARGET_DAYS / BACKFILL_LEG_DAYS);

// One Edge Function invocation's own wall-clock budget (Supabase Edge
// Functions hard-kill at ~150s free tier / 400s paid -- this project is
// confirmed on the free tier). Once an invocation is within roughly one
// chunk-duration's margin of this, the batch-claim loop hands off to a
// fresh invocation (self-chain) instead of risking a hard kill mid-chunk.
const TIME_BUDGET_MS = 110_000;
// A whole run gives up (marks 'partial', stops retrying) after this long --
// PROJECT_DEFAULT, justified against the ~2.8-3 minute theoretical
// Fyers-throughput floor for 501 instruments plus per-chunk overhead (~9
// chunks) plus room for 2-3 whole-chunk retries: a real ~2x margin over a
// realistic bad-but-recoverable run (~15-20 min), so only a genuinely stuck
// run (e.g. Fyers down all day, an expired token nobody rotated) ever gets
// given up on.
const MAX_TOTAL_RUN_DURATION_MS = 40 * 60 * 1000;
// Comfortably longer than one healthy chunk's own processing time (~40-50s
// worst case) -- long enough a healthy chunk is never falsely reclaimed,
// short enough to catch a genuinely stuck one well before an operator would
// notice.
const STALE_BATCH_AFTER_SECONDS = 240;
const MAX_CHUNK_ATTEMPTS = 3;
// 10 concurrent instrument evaluations per chunk: the shared Fyers rate
// limiter (providers/rate-limiter.js, 180/min) serializes the actual HTTP
// calls regardless of how many are "in flight" at once, so this only
// removes idle gaps between fetches/DB writes -- it can never make the
// pipeline exceed the provider's own cap.
const INSTRUMENT_CONCURRENCY = 10;

Deno.serve(async (req) => {
  const invocationStartedAtMs = Date.now();
  const authHeader = req.headers.get("Authorization") ?? "";
  if (authHeader !== `Bearer ${SECRET_KEY}`) {
    return json({ error: "Unauthorized" }, 401);
  }

  const body = await req.json().catch(() => ({}));
  const triggerType = body.trigger_type === "scheduled" ? "scheduled" : "manual";
  const triggeredBy = body.triggered_by ?? null;
  const resumeRunId = body.resume_run_id ?? null;

  const supabase = createClient(SUPABASE_URL, SECRET_KEY);

  let runId = resumeRunId;
  if (!runId) {
    // Fresh run: acquire the lease under a brand-new id before creating
    // anything -- a single atomic UPDATE...WHERE...RETURNING (run-lease.js),
    // so there is no window where two concurrent invocations can both see
    // "free" and both proceed.
    runId = crypto.randomUUID();
    const lease = await acquireRunLease(supabase, RUN_TYPE, runId, { leaseDurationMs: LEASE_DURATION_MS });
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

    const runDate = latestCompletedNseSession(new Date());
    const { data: parameterVersion } = await supabase
      .from("parameter_versions")
      .select("*")
      .order("created_at", { ascending: false })
      .limit(1)
      .maybeSingle();
    const { data: strategyVersions } = await supabase
      .from("strategy_versions")
      .select("id, framework")
      .eq("is_active", true);
    const strategyVersionIds = (strategyVersions ?? []).map((v) => v.id);

    await supabase.from("screening_runs").insert({
      id: runId,
      run_date: runDate,
      mode: "EOD",
      status: "queued",
      universe_version: UNIVERSE_VERSION,
      parameter_version_id: parameterVersion?.id ?? null,
      strategy_version_ids: strategyVersionIds,
      providers: { universe: "nse_archives", ohlcv: "fyers" },
      trigger_type: triggerType,
      triggered_by: triggeredBy,
      started_at: new Date().toISOString(),
    });
    await supabase.from("pipeline_batches").insert({ run_id: runId, stage: "universe", cursor: null, status: "pending" });
    await logStage(supabase, runId, "start", "ok", `Run started (${triggerType})`);
  } else {
    // Resuming: acquireRunLease's CAS matches status='released' regardless
    // of *why* it's released (a clean handoff from the previous invocation,
    // or the recovery sweep finding a stale one) -- no special-casing
    // needed here.
    const lease = await acquireRunLease(supabase, RUN_TYPE, runId, { leaseDurationMs: LEASE_DURATION_MS });
    if (!lease.acquired) {
      // Another invocation (a second self-chain call, or the recovery
      // sweep) got there first -- exactly the double-dispatch case the
      // lease exists to resolve safely. Nothing more for this one to do.
      return json({ runId, status: "running", note: "Another invocation is already resuming this run." });
    }
  }

  const pipeline = runPipeline({ supabase, runId, invocationStartedAtMs });
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

/**
 * Claims and processes pipeline_batches rows for `runId` one at a time until
 * either none remain claimable (the run is actually finished, for real,
 * this invocation) or this invocation's own wall-clock budget is nearly
 * spent (in which case it hands off to a fresh invocation via a self-chain
 * request).
 */
async function runPipeline({ supabase, runId, invocationStartedAtMs }) {
  let releasedForHandoff = false;
  try {
    const { data: run } = await supabase.from("screening_runs").select("*").eq("id", runId).single();
    if (!run) throw new Error(`screening_runs row not found for ${runId}`);
    const runStartedAtMs = new Date(run.started_at).getTime();

    // Pinned to the specific parameter/strategy versions this run started
    // with (stored on the run row at creation) -- not "whatever is
    // currently active," which could change mid-run across many
    // invocations and would otherwise make one run's own results
    // internally inconsistent.
    const { data: parameterVersion } = run.parameter_version_id
      ? await supabase.from("parameter_versions").select("*").eq("id", run.parameter_version_id).maybeSingle()
      : { data: null };
    const parameterValues = flattenParameters(parameterVersion?.values ?? {});

    const { data: ruleDefinitions } = run.strategy_version_ids?.length
      ? await supabase.from("rule_definitions").select("*").in("strategy_version_id", run.strategy_version_ids)
      : { data: [] };
    const ruleDirectionById = Object.fromEntries((ruleDefinitions ?? []).map((r) => [r.rule_id, r.direction]));

    for (;;) {
      const elapsedTotalMs = Date.now() - runStartedAtMs;

      const { data: resetBatches } = await supabase.rpc("reset_stale_pipeline_batches", {
        p_run_id: runId,
        p_stale_after_seconds: STALE_BATCH_AFTER_SECONDS,
        p_max_attempts: MAX_CHUNK_ATTEMPTS,
      });
      for (const rb of resetBatches ?? []) {
        if (rb.status === "failed") {
          await recordGaveUpForBatch({
            supabase,
            runId,
            batch: rb,
            reason: `Chunk abandoned after ${rb.attempt} stale/stuck attempt(s) -- last claimed by an invocation that never finished`,
          });
        }
      }

      if (elapsedTotalMs > MAX_TOTAL_RUN_DURATION_MS) {
        await giveUpOnRun({ supabase, runId });
        break;
      }

      const { data: claimedBatches } = await supabase.rpc("claim_next_pipeline_batch", { p_run_id: runId });
      const batch = claimedBatches?.[0] ?? null;
      if (!batch) {
        // Normally this means processReconcileBatch already ran and
        // finalized the run (reconcile is the last stage, its own batch
        // marked 'done' right after it returns) -- but if reconcile itself
        // permanently failed (exhausted MAX_CHUNK_ATTEMPTS via the stale
        // sweep above), nothing is ever claimable again yet the run was
        // never finalized either. Detect and fix that directly rather than
        // leaving the run stuck 'running'/'queued' forever.
        const { data: freshRun } = await supabase.from("screening_runs").select("status").eq("id", runId).single();
        if (freshRun && (freshRun.status === "queued" || freshRun.status === "running")) {
          await logStage(supabase, runId, "reconcile_stuck", "warning", "No claimable batch remained but the run was never finalized (likely the reconcile stage permanently failed) -- forcing partial.");
          await finalizeRunStatus({ supabase, runId, runStartedAtMs, forceStatus: "partial" });
        }
        break;
      }

      try {
        if (batch.stage === "universe") {
          await processUniverseBatch({ supabase, runId, runDate: run.run_date });
        } else if (batch.stage === "incremental") {
          await processIncrementalBatch({
            supabase,
            runId,
            runDate: run.run_date,
            batch,
            parameterValues,
            ruleDefinitions: ruleDefinitions ?? [],
            ruleDirectionById,
          });
        } else if (batch.stage === "backfill") {
          await processBackfillBatch({ supabase, batch });
        } else if (batch.stage === "reconcile") {
          await processReconcileBatch({ supabase, runId, runStartedAtMs });
        }
        await supabase.from("pipeline_batches").update({ status: "done", updated_at: new Date().toISOString() }).eq("id", batch.id);
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        const gaveUp = batch.attempt >= MAX_CHUNK_ATTEMPTS;
        await supabase
          .from("pipeline_batches")
          .update({ status: gaveUp ? "failed" : "pending", last_error: message, updated_at: new Date().toISOString() })
          .eq("id", batch.id);
        await logStage(
          supabase,
          runId,
          "batch_error",
          "warning",
          `batch ${batch.id} (${batch.stage}) attempt ${batch.attempt} ${gaveUp ? "gave up" : "will retry"}: ${message}`
        );
        if (gaveUp) {
          await recordGaveUpForBatch({ supabase, runId, batch, reason: `Chunk failed ${batch.attempt}x, last error: ${message}` });
        }
      }

      await heartbeatRunLease(supabase, RUN_TYPE, { leaseDurationMs: LEASE_DURATION_MS });

      if (Date.now() - invocationStartedAtMs > TIME_BUDGET_MS) {
        // Hand off to a fresh invocation. Release FIRST: the next
        // invocation's own acquireRunLease call must see status='released',
        // or it fails to acquire since the lease still looks "active" even
        // though this invocation is about to stop.
        await releaseRunLease(supabase, RUN_TYPE);
        releasedForHandoff = true;
        await selfChain(runId);
        return;
      }
    }
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    await logStage(supabase, runId, "error", "failed", message);
    await supabase.from("screening_runs").update({ status: "failed", completed_at: new Date().toISOString() }).eq("id", runId);
  } finally {
    if (!releasedForHandoff) await releaseRunLease(supabase, RUN_TYPE);
  }
}

/** Best-effort continuation call -- the recovery-sweep cron (migration 0008) is the safety net if this never lands. */
async function selfChain(runId) {
  try {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 5000);
    try {
      await fetch(`${SUPABASE_URL}/functions/v1/run-screening`, {
        method: "POST",
        headers: { Authorization: `Bearer ${SECRET_KEY}`, "Content-Type": "application/json" },
        body: JSON.stringify({ trigger_type: "scheduled", resume_run_id: runId }),
        signal: controller.signal,
      });
    } finally {
      clearTimeout(timeout);
    }
  } catch {
    // Swallow -- see comment above this function.
  }
}

/**
 * Force-concludes a run that has exceeded MAX_TOTAL_RUN_DURATION_MS: fails
 * every batch still pending/in_progress, records an honest "gave up"
 * terminal row (never a fabricated one) for any instrument that never got a
 * real attempt, then finalizes as 'partial' -- unconditionally, since
 * reaching this path already means not every instrument got a genuine
 * attempt.
 */
async function giveUpOnRun({ supabase, runId }) {
  const { data: stuckBatches } = await supabase
    .from("pipeline_batches")
    .update({ status: "failed", last_error: `Run exceeded its ${Math.round(MAX_TOTAL_RUN_DURATION_MS / 60000)}-minute total duration cap`, updated_at: new Date().toISOString() })
    .eq("run_id", runId)
    .in("status", ["pending", "in_progress"])
    .select("stage, cursor, attempt");

  for (const batch of stuckBatches ?? []) {
    await recordGaveUpForBatch({
      supabase,
      runId,
      batch,
      reason: `Run exceeded its ${Math.round(MAX_TOTAL_RUN_DURATION_MS / 60000)}-minute total duration cap before this chunk could be attempted`,
    });
  }

  await logStage(supabase, runId, "time_budget", "warning", `Run exceeded its total duration cap with ${(stuckBatches ?? []).length} batch(es) never resolved`);
  await finalizeRunStatus({ supabase, runId, forceStatus: "partial" });
}

/**
 * Inserts honest "gave up" terminal rows for any instrument in `batch`'s own
 * cursor that still has no instrument_run_results row -- used both when a
 * chunk permanently fails (exhausted retries, live or via the stale sweep)
 * and when a whole run gives up. No-op for non-'incremental' stages
 * (backfill/universe/reconcile never produce instrument_run_results rows
 * themselves).
 */
async function recordGaveUpForBatch({ supabase, runId, batch, reason }) {
  if (batch.stage !== "incremental" || !batch.cursor) return;
  const instruments = JSON.parse(batch.cursor);
  const { data: existingResults } = await supabase
    .from("instrument_run_results")
    .select("instrument_id")
    .eq("run_id", runId)
    .in(
      "instrument_id",
      instruments.map((i) => i.instrumentId)
    );
  const doneIds = new Set((existingResults ?? []).map((r) => r.instrument_id));
  const missing = instruments.filter((i) => !doneIds.has(i.instrumentId));
  if (missing.length > 0) {
    await recordGaveUpBulk({ supabase, runId, instruments: missing, reason });
  }
}

/** Bulk, idempotent (upsert) insert of honest terminal rows -- never the old "ran out of time" wording; `reason` must state what actually happened. */
async function recordGaveUpBulk({ supabase, runId, instruments, reason }) {
  const resultRows = instruments.map((instrument) => ({
    run_id: runId,
    instrument_id: instrument.instrumentId,
    is_index: instrument.isIndex,
    terminal_state: "NO_DATA",
    tier: "unavailable",
    direction: null,
    score: null,
    component_scores: null,
    failed_gates: [],
    data_quality: "NO_DATA",
  }));
  const qualityRows = instruments.map((instrument) => ({
    run_id: runId,
    instrument_id: instrument.instrumentId,
    check_name: "ingestion",
    result: "NO_DATA",
    details: { note: reason },
  }));
  await supabase.from("instrument_run_results").upsert(resultRows, { onConflict: "run_id,instrument_id" });
  await supabase.from("data_quality_results").insert(qualityRows);
  return resultRows;
}

/**
 * The 'universe' stage: builds this run's instrument/index-membership set
 * (unchanged logic, buildUniverse below), then -- only the first time this
 * succeeds for the run (idempotent guard, since a retried universe batch
 * must not re-seed and duplicate every other batch) -- seeds every
 * 'incremental'/'backfill'/'reconcile' pipeline_batches row.
 */
async function processUniverseBatch({ supabase, runId, runDate }) {
  const membership = await buildUniverse(supabase, runId, runDate);
  await logStage(supabase, runId, "universe", "ok", `${INDEX_IDS.length} indexes, ${membership.size} unique constituents`);

  // Idempotent guard against a retry of this SAME batch (crashed after
  // buildUniverse but before finishing the seeding below): the 'reconcile'
  // row is inserted last, so its existence is the definitive "fully seeded"
  // marker. If a retry gets past this check, the incremental/backfill rows
  // below are upserted (not inserted) specifically so re-seeding after a
  // partial prior attempt never collides with rows that already made it in.
  const { data: existingReconcile } = await supabase.from("pipeline_batches").select("id").eq("run_id", runId).eq("stage", "reconcile").maybeSingle();
  if (existingReconcile) return;

  const allInstruments = [
    ...INDEX_IDS.map((id) => ({ instrumentId: id, symbol: id, isIndex: true })),
    ...[...membership.entries()].map(([id, m]) => ({ instrumentId: id, symbol: m.symbol, isIndex: false })),
  ];
  const shuffled = seededShuffle(allInstruments, `${RUN_TYPE}:${runDate}`);
  const incrementalRows = buildChunks(shuffled, CHUNK_SIZE).map((chunk) => ({
    run_id: runId,
    stage: "incremental",
    cursor: JSON.stringify(chunk),
    status: "pending",
  }));

  // Backfill: only non-index instruments with literally zero stored daily
  // bars -- existence of any stored bar IS the "already backfilled" flag,
  // self-limiting with no separate mutable column needed.
  const nonIndexIds = [...membership.keys()];
  let backfillCandidates = [];
  if (nonIndexIds.length > 0) {
    const { data: barred } = await supabase.from("market_bars_raw").select("instrument_id").eq("interval", "1d").in("instrument_id", nonIndexIds);
    const hasBarSet = new Set((barred ?? []).map((r) => r.instrument_id));
    backfillCandidates = [...membership.entries()]
      .filter(([id]) => !hasBarSet.has(id))
      .map(([id, m]) => ({ instrumentId: id, symbol: m.symbol, isIndex: false }));
  }
  const backfillRows = buildChunks(backfillCandidates, BACKFILL_CHUNK_SIZE).map((chunk) => ({
    run_id: runId,
    stage: "backfill",
    cursor: JSON.stringify(chunk),
    status: "pending",
  }));

  const rowsToInsert = [...incrementalRows, ...backfillRows];
  if (rowsToInsert.length > 0) {
    await supabase.from("pipeline_batches").upsert(rowsToInsert, { onConflict: "run_id,stage,cursor", ignoreDuplicates: true });
  }
  await supabase.from("pipeline_batches").insert({ run_id: runId, stage: "reconcile", cursor: null, status: "pending" });
  await supabase.from("screening_runs").update({ status: "running" }).eq("id", runId).eq("status", "queued");
}

/**
 * The 'incremental' stage: this chunk's instruments, minus whichever
 * already have a real instrument_run_results row for this run (idempotent
 * retry -- no wasted Fyers requests re-attempting already-done work),
 * evaluated with INSTRUMENT_CONCURRENCY-bounded concurrency.
 */
async function processIncrementalBatch({ supabase, runId, runDate, batch, parameterValues, ruleDefinitions, ruleDirectionById }) {
  const instruments = JSON.parse(batch.cursor);
  const { data: alreadyDone } = await supabase
    .from("instrument_run_results")
    .select("instrument_id")
    .eq("run_id", runId)
    .in(
      "instrument_id",
      instruments.map((i) => i.instrumentId)
    );
  const doneSet = new Set((alreadyDone ?? []).map((r) => r.instrument_id));
  const remaining = instruments.filter((i) => !doneSet.has(i.instrumentId));

  await runWithConcurrencyLimit(remaining, INSTRUMENT_CONCURRENCY, (instrument) =>
    evaluateInstrument({ supabase, runId, runDate, instrument, ruleDefinitions, parameterValues, ruleDirectionById })
  );
}

/**
 * The 'backfill' stage: for instruments that still have zero stored daily
 * bars (checked again here, not just at batch-creation time, in case a
 * concurrent chunk already covered one), fetches up to MAX_BACKFILL_LEGS
 * sequential <=366-day legs walking backward from today, stopping early on
 * a short/empty response (no more history available that far back).
 * Best-effort: a failed leg keeps whatever earlier legs already fetched
 * rather than discarding real, honestly-obtained history.
 */
async function processBackfillBatch({ supabase, batch }) {
  const instruments = JSON.parse(batch.cursor);
  await runWithConcurrencyLimit(instruments, INSTRUMENT_CONCURRENCY, async (instrument) => {
    const { data: existing } = await supabase
      .from("market_bars_raw")
      .select("session_date")
      .eq("instrument_id", instrument.instrumentId)
      .eq("interval", "1d")
      .limit(1)
      .maybeSingle();
    if (existing) return;

    let to = new Date();
    let allBars = [];
    for (let leg = 0; leg < MAX_BACKFILL_LEGS; leg++) {
      const from = new Date(to.getTime() - BACKFILL_LEG_DAYS * 24 * 60 * 60 * 1000);
      let legBars;
      try {
        const ohlcv = await fetchOHLCVRange(instrument.instrumentId, instrument.symbol, from, to, supabase);
        legBars = ohlcv.data;
      } catch {
        break; // best-effort -- keep whatever earlier legs already fetched
      }
      if (legBars.length === 0) break; // no more history available this far back
      allBars = allBars.concat(legBars);
      to = from;
    }
    if (allBars.length > 0) {
      await writeRawBars(supabase, instrument.instrumentId, allBars);
    }
  });
}

/** The 'reconcile' stage: ranking, coverage, and the run's final status -- see finalizeRunStatus. */
async function processReconcileBatch({ supabase, runId, runStartedAtMs }) {
  await finalizeRunStatus({ supabase, runId, runStartedAtMs });
}

/**
 * Computes ranking + coverage_reconciliation + the run's final status, and
 * writes all three. componentScores were persisted on instrument_run_results
 * at evaluation time specifically so this reconstruction works correctly
 * even when an instrument was evaluated in a different invocation than this
 * one (no shared in-memory state across invocations/isolates).
 *
 * `forceStatus`, when given, skips decideRunStatus entirely -- used by the
 * give-up paths (giveUpOnRun, the reconcile-permanently-failed fallback in
 * runPipeline), where reaching this function already means not every
 * instrument got a genuine attempt, so there's nothing left to decide.
 */
async function finalizeRunStatus({ supabase, runId, runStartedAtMs, forceStatus }) {
  const { data: incrementalBatches } = await supabase.from("pipeline_batches").select("cursor").eq("run_id", runId).eq("stage", "incremental");
  const universeCount = uniqueInstrumentsFromCursors(incrementalBatches ?? []).length;

  const { data: stockResults } = await supabase
    .from("instrument_run_results")
    .select("instrument_id, tier, direction, score, component_scores")
    .eq("run_id", runId)
    .eq("is_index", false);
  const rows = stockResults ?? [];

  // Ranking only ever compares within the same (direction, tier) pair
  // (shared-gates.yaml: within_same_direction_and_tier_only) -- delete+
  // reinsert rather than upsert since `rankings` has no natural per-run
  // unique key to upsert on, and this function can legitimately run more
  // than once for a run that had a transient failure before this point.
  const rankingInputs = rows
    .filter((r) => r.tier === "tier_a" || r.tier === "tier_b")
    .map((r) => ({ instrumentId: r.instrument_id, direction: r.direction, tier: r.tier, score: r.score ?? 0, componentScores: r.component_scores ?? {} }));
  const ranked = rankWithinTiers(rankingInputs);
  await supabase.from("rankings").delete().eq("run_id", runId);
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

  const coverage = reconcileCoverage(rows.map((r) => ({ tier: r.tier })));
  await supabase.from("coverage_reconciliation").upsert({ run_id: runId, ...coverage }, { onConflict: "run_id" });

  let status = forceStatus;
  if (!status) {
    const { data: batches } = await supabase.from("pipeline_batches").select("stage, status").eq("run_id", runId);
    status = decideRunStatus({
      batches: batches ?? [],
      universeCount,
      resultCount: rows.length,
      elapsedMs: Date.now() - runStartedAtMs,
      maxDurationMs: MAX_TOTAL_RUN_DURATION_MS,
    });
  }

  await supabase.from("screening_runs").update({ status, completed_at: new Date().toISOString() }).eq("id", runId);
  await logStage(supabase, runId, "complete", status === "completed" ? "ok" : "warning", `status=${status} universeCount=${universeCount} resultCount=${rows.length}`);
}

/** The expected non-index universe -- the union of every 'incremental' batch's own instrument list, deduplicated. */
function uniqueInstrumentsFromCursors(rows) {
  const seen = new Map();
  for (const row of rows) {
    if (!row.cursor) continue;
    for (const item of JSON.parse(row.cursor)) {
      if (!item.isIndex) seen.set(item.instrumentId, item);
    }
  }
  return [...seen.values()];
}

/** Runs `worker` over `items` with at most `limit` in flight at once, preserving no particular return-value ordering (callers here only care about side effects). */
async function runWithConcurrencyLimit(items, limit, worker) {
  let nextIndex = 0;
  async function runNext() {
    while (nextIndex < items.length) {
      const i = nextIndex++;
      await worker(items[i], i);
    }
  }
  const workers = Array.from({ length: Math.min(limit, items.length) }, runNext);
  await Promise.all(workers);
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

  // Closes a previously-flagged gap: a constituent this run's fetch didn't
  // see for a given index is no longer current, but nothing before this
  // ever retired its earlier is_current row -- they'd accumulate forever.
  for (const indexId of INDEX_IDS) {
    const currentIds = new Set([...membership.entries()].filter(([, m]) => m.indexIds.has(indexId)).map(([id]) => id));
    const { data: existingMembers } = await supabase.from("index_memberships").select("instrument_id").eq("index_id", indexId).eq("is_current", true);
    const staleIds = (existingMembers ?? []).map((r) => r.instrument_id).filter((id) => !currentIds.has(id));
    if (staleIds.length > 0) {
      await supabase.from("index_memberships").update({ is_current: false }).eq("index_id", indexId).in("instrument_id", staleIds);
    }
  }

  return membership;
}

/** Upserts fetched daily bars, trying migration 0006's interval-aware shape first and falling back to the pre-migration shape if that column set doesn't exist yet. No-op on an empty array. */
async function writeRawBars(supabase, instrumentId, bars) {
  if (bars.length === 0) return;
  const rawBarsNewShape = bars.map((b) => ({
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
  }));
  const { error } = await supabase.from("market_bars_raw").upsert(rawBarsNewShape, { onConflict: "instrument_id,interval,ts,provider" });
  if (error) {
    const rawBarsOldShape = bars.map((b) => ({
      instrument_id: instrumentId,
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
}

/**
 * Evaluates one instrument for this run: incremental Fyers fetch (only the
 * days missing since the last stored bar -- nextIncrementalRange,
 * providers/fyers.js), re-reads the FULL OHLCV_LOOKBACK_DAYS window back
 * from storage (every downstream feature needs the complete window, e.g.
 * EMA-200/MACD warm-up -- the fetch is incremental, the analysis window is
 * not), validation, direction analysis, rule evaluation, hourly routes, and
 * the final classified result row.
 */
async function evaluateInstrument({ supabase, runId, runDate, instrument, ruleDefinitions, parameterValues, ruleDirectionById }) {
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
    const { data: latestBar } = await supabase
      .from("market_bars_raw")
      .select("session_date")
      .eq("instrument_id", instrument.instrumentId)
      .eq("interval", "1d")
      .order("session_date", { ascending: false })
      .limit(1)
      .maybeSingle();

    const range = nextIncrementalRange(latestBar?.session_date ?? null, runDate, OHLCV_LOOKBACK_DAYS);
    if (range) {
      const ohlcv = await fetchOHLCVRange(instrument.instrumentId, instrument.symbol, range.from, range.to, supabase);
      await writeRawBars(supabase, instrument.instrumentId, ohlcv.data);
    }

    const windowStartDate = new Date(new Date(`${runDate}T00:00:00Z`).getTime() - OHLCV_LOOKBACK_DAYS * 24 * 60 * 60 * 1000)
      .toISOString()
      .slice(0, 10);
    const { data: storedBars, error: readError } = await supabase
      .from("market_bars_raw")
      .select("session_date, open, high, low, close, volume")
      .eq("instrument_id", instrument.instrumentId)
      .eq("interval", "1d")
      .gte("session_date", windowStartDate)
      .lte("session_date", runDate)
      .order("session_date", { ascending: true });
    if (readError) throw readError;

    bars = (storedBars ?? []).map((b) => ({ date: b.session_date, open: b.open, high: b.high, low: b.low, close: b.close, volume: b.volume }));
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
      component_scores: null,
      failed_gates: [],
      data_quality: dataQuality,
    };
    await supabase.from("instrument_run_results").upsert(resultRow, { onConflict: "run_id,instrument_id" });
    return { resultRow };
  }

  // Adjusted bars (problem #20): raw + adjusted are stored separately, with
  // an explicit adjustment_version, rather than pivots/patterns ever running
  // on raw unadjusted data. No corporate-action data is ingested into this
  // project yet (corporate_actions stays empty -- no ingestion source has
  // been identified; separately, whether Fyers' own history API already
  // returns split/bonus-adjusted prices is UNRESOLVED -- couldn't be
  // confirmed from public docs, only that the charting UI is adjusted with
  // a user toggle -- so this must be empirically verified against a known
  // past split before corporate-action ingestion is ever built, to avoid
  // double-adjusting), so this is a structural no-op today -- computeAdjustedBars
  // returns bars unchanged when there are no qualifying actions -- but the
  // storage path and versioning are real.
  try {
    const { data: corporateActions } = await supabase.from("corporate_actions").select("action_type, ex_date, factor").eq("instrument_id", instrument.instrumentId);
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
    await logStage(
      supabase,
      runId,
      "adjusted_bars",
      "warning",
      `${instrument.instrumentId}: adjusted-bar storage failed: ${err instanceof Error ? err.message : String(err)}`
    );
  }

  // Idempotent-retry cleanup: clear this instrument's own prior
  // bar_validation/rule_traces rows for this run before rewriting them,
  // closing the narrow window where a process died after those writes but
  // before the instrument_run_results row below (which is what the
  // idempotent-skip filter upstream actually checks).
  await Promise.all([
    supabase.from("data_quality_results").delete().eq("run_id", runId).eq("instrument_id", instrument.instrumentId).eq("check_name", "bar_validation"),
    supabase.from("rule_traces").delete().eq("run_id", runId).eq("instrument_id", instrument.instrumentId),
  ]);

  // Direction analysis (writes instrument_direction* / pattern_detections /
  // instrument_alignment) and rule evaluation (writes rule_traces) both only
  // need `bars` -- neither reads the other's output, so they run
  // concurrently rather than one blocking the other's network round trips.
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

  // 1-hour bar ingestion + route detection: both swing playbooks state "M1
  // AND M2 AND M3 AND M4 must all pass before the hourly chart is opened" --
  // so this only spends Fyers request budget on an instrument once its
  // weekly+daily direction lock has actually cleared.
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
  // bearish are always separate rows (problem #15). Failure here must never
  // block instrument_run_results below.
  try {
    await persistSwingAnalysisResults({ supabase, runId, instrument, traces, routeEvidence, dailyBars: bars, parameterValues: parameterValues.documented ?? {} });
  } catch (err) {
    await logStage(
      supabase,
      runId,
      "swing_analysis",
      "warning",
      `${instrument.instrumentId}: swing analysis persistence failed: ${err instanceof Error ? err.message : String(err)}`
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
    component_scores: componentScores,
    failed_gates: failedGates,
    data_quality: dataQuality,
  };
  await supabase.from("instrument_run_results").upsert(resultRow, { onConflict: "run_id,instrument_id" });

  return { resultRow };
}

/**
 * Persists evaluateSwingHypothesis's bullish and bearish results (when
 * present) into swing_analysis_results, plus each hypothesis's own gate
 * traces into swing_analysis_rule_traces. swing_analysis_results is upserted
 * per (run_id, instrument_id, hypothesis) since a run only ever evaluates an
 * instrument once; swing_analysis_rule_traces is delete-then-insert under
 * that result's id so a retry within the same run_id never leaves stale
 * duplicate traces.
 *
 * Assembles the full M5-M8 evidence bundle (route selection, M6 PAPA
 * trigger, M7 SMM Hat, M8 reward:risk, the 5 confirmation groups, vetoes)
 * per hypothesis and hands it to evaluateSwingHypothesis, which is the one
 * place finalAction actually gets decided -- this function only gathers
 * evidence, it never computes a verdict itself.
 */
async function persistSwingAnalysisResults({ supabase, runId, instrument, traces, routeEvidence, dailyBars, parameterValues }) {
  const minimumRewardRiskStrict = parameterValues.swing_minimum_reward_risk_strict ?? null;
  const hourlyBars = routeEvidence?.hourlyBars ?? [];
  const latestDailyClose = dailyBars.length > 0 ? dailyBars[dailyBars.length - 1].close : null;
  const dailyStructure = routeEvidence
    ? { state: routeEvidence.dailyDowState, lastSwingHigh: routeEvidence.dailySwingHigh, lastSwingLow: routeEvidence.dailySwingLow }
    : null;

  for (const hypothesis of ["bullish", "bearish"]) {
    const bullish = hypothesis === "bullish";

    // Route evidence (features/hourly-routes.js -- 5 of the 10 documented
    // routes so far, see that file's own scope note for the rest). A wave
    // hypothesis can only be in one Elliott position at a time, so at most
    // one detector should match today, but this handles routeEvidence as an
    // array (0, 1, or more matches) rather than assuming that stays true as
    // more routes are added. When no route's required checks all pass, the
    // FIRST detected-but-unconfirmed route (if any) is still surfaced as
    // `selectedRouteForEvidence` for the reward:risk/veto checks below to
    // work against -- evaluateSwingHypothesis itself only ever treats a
    // route as satisfying M5 when `requiredChecksPassed` is true, so this
    // never lets an unconfirmed route masquerade as a real M5 pass.
    const routes = routeEvidence?.[hypothesis] ?? [];
    const passingRoute = routes.find((r) => r.requiredChecksPassed);
    const selectedRouteForEvidence = passingRoute ?? routes[0] ?? null;

    const papaFormationTriggered = (routeEvidence?.papaFormations?.[hypothesis]?.length ?? 0) > 0;
    const smmHat = routeEvidence?.smmHat?.[hypothesis] ?? null;
    const latestHourlyClose = hourlyBars.length > 0 ? hourlyBars[hourlyBars.length - 1].close : null;

    const rewardRisk =
      minimumRewardRiskStrict != null
        ? computeRewardRisk({ route: selectedRouteForEvidence, bullish, currentPrice: latestHourlyClose, minimumRewardRiskStrict })
        : null;

    const confirmationGroups = evaluateConfirmationGroups({
      directionLockPassed: directionLockPassed(hypothesis, traces),
      selectedRoute: selectedRouteForEvidence,
      papaFormationTriggered,
      smmHat,
      adxCondition: routeEvidence?.adxCondition ?? null,
    });

    const vetoes = evaluateSwingVetoes({
      route: selectedRouteForEvidence,
      bullish,
      hourlyBars,
      dailyStructure,
      latestDailyClose,
      weeklyMacdHistogramChange: routeEvidence?.weeklyMacdHistogramChange ?? null,
      rewardRiskRatio: rewardRisk?.rewardRiskRatio ?? null,
      minimumRewardRiskStrict,
    });

    const analysis = evaluateSwingHypothesis(hypothesis, traces, {
      adxCondition: routeEvidence?.adxCondition ?? null,
      selectedRoute: selectedRouteForEvidence,
      papaFormationTriggered,
      smmHat,
      rewardRisk,
      confirmationGroups,
      vetoes,
    });
    if (!analysis) continue; // no WBP-/WSP- gates evaluated this run -- strategy not seeded/active yet

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
          combination_matrix: Object.keys(analysis.combinationMatrix).length > 0 ? analysis.combinationMatrix : null,
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
 * fetchHourlyOHLCV), upserts them into market_bars_raw with interval='1h',
 * then computes every piece of real M5-M8 evidence this cycle's modules can
 * produce, against whichever hypothesis actually qualified
 * (bullishQualifiesForHourly/bearishQualifiesForHourly, from
 * directionLockPassed()):
 *   - M5 (features/hourly-routes.js): detectWave3Ignition/detectWave2Pullback
 *     for both hypotheses, plus detectWave5Exhaustion for the bearish
 *     hypothesis only (SELL-1 has no bullish mirror -- it tests a completed
 *     BULLISH impulse exhausting into a bearish signal). A wave hypothesis
 *     can only be in one Elliott position at a time, so in practice at most
 *     one detector matches per hypothesis today -- but this collects an
 *     array rather than assuming that stays true as more routes are added.
 *   - M6 (features/papa-formations.js): every TRIGGERED PAPA formation.
 *   - M7 (features/smm-hat.js): the Bull/Bear Hat, reusing the SAME daily
 *     MACD histogram phase and Dow state WBP-M4/WSP-S4 already read from
 *     `traces` (recomputed here directly on `dailyBars` rather than parsed
 *     back out of the trace array, since this function doesn't receive
 *     `traces` -- same inputs, same result).
 *   - The hourly combination-matrix ADX WAIT condition
 *     (features/hourly-conditions.js), unchanged from before this cycle.
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
 * @returns {{bullish: object[], bearish: object[], adxCondition: object|null,
 *   papaFormations: {bullish: object[], bearish: object[]},
 *   smmHat: {bullish: object|null, bearish: object|null},
 *   weeklyMacdHistogramChange: string|null,
 *   dailyDowState: string|null, dailySwingHigh: number|null, dailySwingLow: number|null,
 *   hourlyBars: object[]}|null}
 *   every matching route detector's result per hypothesis (only for the
 *   hypothesis(es) that qualified) plus the rest of the M5-M8 evidence, or
 *   null if there were no hourly bars to work with (or the required
 *   zigzag_hourly_pct/dailyZigzagPct/hour_slot_volume_lookback_sessions
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

  const detectAll = (bullish) => {
    const routes = [
      detectWave3Ignition({ hourlyBars, dailyBars, bullish, hourlyZigzagPct, dailyZigzagPct, hourSlotVolumeLookbackSessions }),
      detectWave2Pullback({ hourlyBars, bullish, hourlyZigzagPct }),
    ];
    if (!bullish) routes.push(detectWave5Exhaustion({ hourlyBars, dailyBars, hourlyZigzagPct, dailyZigzagPct, hourSlotVolumeLookbackSessions }));
    return routes.filter(Boolean);
  };

  const adxDmiPeriod = parameterValues.adx_dmi_period;
  const waitBelowThreshold = parameterValues.swing_hourly_adx_wait_below;
  const flatCeiling = parameterValues.swing_hourly_adx_flat_ceiling;
  const adxCondition =
    adxDmiPeriod == null || waitBelowThreshold == null || flatCeiling == null
      ? null
      : evaluateHourlyAdxCondition({
          highs: hourlyBars.map((b) => b.high),
          lows: hourlyBars.map((b) => b.low),
          closes: hourlyBars.map((b) => b.close),
          period: adxDmiPeriod,
          waitBelowThreshold,
          flatCeiling,
        });

  // M6/M7 evidence shared across both hypotheses' own directional detectors.
  const dailyPivots = zigzagPivots(dailyBars, dailyZigzagPct);
  const dailyDowStructure = classifyDowStructure(dailyPivots, dailyBars[dailyBars.length - 1].close);
  const hourlyPivots = zigzagPivots(hourlyBars, hourlyZigzagPct);

  const macdFast = parameterValues.macd_fast;
  const macdSlow = parameterValues.macd_slow;
  const macdSignal = parameterValues.macd_signal;
  const macdParamsResolved = macdFast != null && macdSlow != null && macdSignal != null;
  const dailyMacdHistogramPhase = macdParamsResolved ? macdHistogramPhase(dailyBars.map((b) => b.close), macdFast, macdSlow, macdSignal, 4) : { change: null, priorPhase: null };
  const weeklyMacdHistogramChange = macdParamsResolved ? macdHistogramPhase(aggregateBars(dailyBars, "weekly").map((b) => b.close), macdFast, macdSlow, macdSignal, 4).change : null;

  const papaFormationsFor = (bullish) => detectTriggeredPapaFormations({ hourlyBars, hourlyPivots, dailyPivots, bullish });
  const smmHatFor = (bullish) =>
    evaluateSmmHat({ dailyMacdHistogramPhase, dailyDowState: dailyDowStructure.state, hourlyBars, hourSlotVolumeLookbackSessions, bullish });

  return {
    bullish: bullishQualifiesForHourly ? detectAll(true) : [],
    bearish: bearishQualifiesForHourly ? detectAll(false) : [],
    adxCondition,
    papaFormations: {
      bullish: bullishQualifiesForHourly ? papaFormationsFor(true) : [],
      bearish: bearishQualifiesForHourly ? papaFormationsFor(false) : [],
    },
    smmHat: {
      bullish: bullishQualifiesForHourly ? smmHatFor(true) : null,
      bearish: bearishQualifiesForHourly ? smmHatFor(false) : null,
    },
    weeklyMacdHistogramChange,
    dailyDowState: dailyDowStructure.state,
    dailySwingHigh: dailyDowStructure.lastSwingHigh,
    dailySwingLow: dailyDowStructure.lastSwingLow,
    hourlyBars,
  };
}

/**
 * Renders/uploads a chart and upserts its instrument_direction row for each
 * timeframe whose pivot+latest-bar hash changed since the last run -- an
 * unchanged hash means the chart and row are left exactly as they are (the
 * feature's own "keep the same image if unchanged" requirement).
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
  // at once. Running the three timeframes concurrently instead of one after
  // another cuts this section's wall-clock time roughly 3x with no
  // behavior change.
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

      // Run-scoped schema: instrument_direction above is latest-state only
      // and gets overwritten every run, so it can never answer "what did we
      // actually see on run X" -- these tables are this run's immutable
      // evidence. Failure here must never block the legacy row above (still
      // what the live Direction page reads) or pattern detection below.
      try {
        await persistDirectionRun({ supabase, runId, instrument, timeframe, tf, objectPath });
      } catch (err) {
        await logStage(
          supabase,
          runId,
          "direction_run",
          "warning",
          `${instrument.instrumentId}/${timeframe}: run-scoped direction/wave persistence failed: ${err instanceof Error ? err.message : String(err)}`
        );
      }

      // Pattern detection is computed regardless of persistence success (the
      // in-memory hits still feed final_alignment below even if the insert
      // fails). It's also fresh evidence for this run, not a derived cache
      // keyed off the direction hash -- a candlestick/double-extreme pattern
      // can newly qualify even when the underlying pivot structure hasn't
      // changed (e.g. one more bar closes the engulfing pair). A persistence
      // failure must never block the direction row above, which is why it's
      // a separate try/catch per timeframe rather than folded into the
      // block above.
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
          `${instrument.instrumentId}/${timeframe}: pattern detection persistence failed: ${err instanceof Error ? err.message : String(err)}`
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
      `${instrument.instrumentId}: final_alignment computation/persistence failed: ${err instanceof Error ? err.message : String(err)}`
    );
  }
}

/**
 * Persists one timeframe's direction/wave analysis into the run-scoped
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
 * results through an insert into pattern_detections, but still returns the
 * computed hits either way so alignment computation always has real pattern
 * evidence to work with. Deliberately an INSERT, not an upsert:
 * pattern_detections is immutable per-run evidence, not a latest-state row
 * like instrument_direction above -- a pattern observed in an earlier run
 * and never re-detected simply stops appearing in later runs' evidence
 * rather than being overwritten.
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
 * alignment.js) and upserts it into instrument_alignment.
 * monthly/weekly/daily_direction_id and elliott_hypothesis_id are
 * deliberately left null: they reference instrument_direction_runs/
 * elliott_hypotheses rows this same call already wrote, but resolving their
 * exact ids here would mean a second round trip per timeframe for no
 * consumer today -- populating them is future work, not invented now.
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

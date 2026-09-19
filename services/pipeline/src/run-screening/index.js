// EOD screening pipeline (Cloud Run Job) -- the orchestrator described in
// references/technical-architecture.md's "Job sequence":
//   universe -> ingest -> validate -> features -> rule evaluation ->
//   ranking -> coverage reconciliation -> persist -> (publish only if
//   reconciled).
//
// Started by: Cloud Scheduler (weekday EOD, TRIGGER_TYPE=scheduled) or the web
// app's POST /api/screening-runs (Researcher+ only, TRIGGER_TYPE=manual); see
// ../jobs/screening.mjs. A resumed execution (RESUME_RUN_ID) continues an
// interrupted run from its persisted batch state.
//
// Durable pipeline (2026-09-11 rewrite): a run's ~501-instrument universe is
// split into pipeline_batches rows (migration 0008): universe (build the
// universe, seed every other batch), incremental (this run's fresh daily bars
// for a chunk of instruments), backfill (one-time deeper history for
// instruments that have none stored yet), reconcile (ranking/coverage/final
// status, once every universe/incremental batch is resolved). Batches are
// claimed one at a time via the atomic claim_next_pipeline_batch() function
// (FOR UPDATE SKIP LOCKED). On Supabase this had to be chained across many
// short invocations (a ~150s hard kill) with a cron recovery sweep as the
// safety net; a Cloud Run Job runs the whole pipeline in one execution
// (task timeout up to hours), so the wall-clock handoff, self-chain request and
// recovery sweep are gone. The batch/lease/stale-reset design stays: it is what
// makes a killed or retried execution safe to resume and a duplicate start
// harmless.
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
// Data sources (as of 2026-09-07): index constituent lists come from NSE's
// static archive CSVs (providers/nse-archives.js); OHLCV comes from Fyers'
// licensed data API (providers/fyers.js).

import { setTimeout as sleep } from "node:timers/promises";
import * as ops from "../db/ops.js";
import { FyersAuthError } from "./providers/fyers-credentials.js";
import { fetchIndexConstituents } from "./providers/nse-archives.js";
import { fetchOHLCVRange, fetchHourlyOHLCV, nextIncrementalRange } from "./providers/fyers.js";
import { validateBars } from "./quality.js";
import { buildFeatureContext } from "./features/context.js";
import { buildDirectionAnalysis, ALGORITHM_VERSION as DIRECTION_ALGORITHM_VERSION } from "./features/direction.js";
import { detectCandlestickPatterns, detectDoubleExtremePatterns, PATTERN_PARAM_VERSION } from "./features/patterns.js";
import { computeFinalAlignment } from "./features/alignment.js";
import { evaluateSwingHypothesis, directionLockPassed, toPersistedSwingTrace } from "./features/swing-analysis.js";
import { detectWave3Ignition, detectWave2Pullback, detectWave5Exhaustion } from "./features/hourly-routes.js";
import { evaluateHourlyAdxCondition } from "./features/hourly-conditions.js";
import { zigzagPivots, classifyDowStructure, aggregateBars } from "./features/structure.js";
import { macdHistogramPhase } from "./features/indicators.js";
import { detectTriggeredPapaFormations } from "./features/papa-formations.js";
import { evaluateSmmHat } from "./features/smm-hat.js";
import { computeRewardRisk } from "./features/reward-risk.js";
import { evaluateConfirmationGroups } from "./features/confirmation-groups.js";
import { evaluateSwingVetoes } from "./features/swing-vetoes.js";
import { ANALYSIS_SERIES_VERSION, buildAnalysisBars, FYERS_ADJUSTMENT_PROVENANCE, FYERS_ADJUSTMENT_STATE } from "./features/analysis-bars.js";
import { renderChartSvg, RENDER_VERSION } from "./charts/render.js";
import { immutableChartIdentity } from "./charts/immutable-path.js";
import { evaluateRules } from "./rules/evaluate.js";
import { classify, scoreComponents, rankWithinTiers } from "./rank.js";
import { filterScreeningRules } from "./pipeline/screening-rules.js";
import { reconcileCoverage } from "./reconcile.js";
import { acquireRunLease, heartbeatRunLease, releaseRunLease } from "./run-lease.js";
import { freezeEodCutoff, normalizeCompletedHourlyBars } from "./nse-calendar.js";
import { seededShuffle } from "./pipeline/shuffle.js";
import { buildChunks, CHUNK_SIZE, BACKFILL_CHUNK_SIZE } from "./pipeline/chunks.js";
import { decideRunStatus } from "./pipeline/run-status.js";

const DIRECTION_TIMEFRAMES = ["daily", "weekly", "monthly"];
const RUN_TYPE = "eod_screening";
// History: originally 3 min. Raised to 10 min on 2026-09-14 after confirming
// live (five straight fresh runs) that heartbeatRunLease was only called
// once per *completed* batch, so a single slow batch (a chunk sharing the
// cross-invocation Fyers rate-limit bucket with another in-flight chunk can
// legitimately take several minutes) let the lease expire mid-batch --
// the very next eod-screening-recovery-sweep cron tick (every minute) then
// started a genuinely concurrent SECOND invocation for the same run, which
// competed for the same shared rate-limit budget. That fixed the race, but
// tied dead-invocation recovery time to the same 10 minutes, and a run
// needing two such recoveries blew its own MAX_TOTAL_RUN_DURATION_MS budget
// (confirmed live 2026-09-15). Reverted to a short value now that
// withLeaseHeartbeat (below) refreshes the lease continuously *during* a
// batch's own processing, not just after -- a genuinely live invocation
// never loses its lease regardless of how long one batch takes, while a
// truly dead one (hard-killed, crashed) stops heartbeating immediately and
// is detected within one lease window. Must comfortably exceed
// HEARTBEAT_INTERVAL_MS (several heartbeat opportunities per window, so one
// dropped heartbeat is never fatal).
const LEASE_DURATION_MS = 3 * 60 * 1000;
// How often a live invocation refreshes its own lease while a batch is
// still being processed (see withLeaseHeartbeat) -- decoupled from
// heartbeatRunLease's other call site (once per completed batch, a
// cheap immediate refresh) so lease freshness no longer depends on how long
// an individual batch's own work takes.
const HEARTBEAT_INTERVAL_MS = 45 * 1000;

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

// How long the job waits before re-checking when batches are outstanding but not
// claimable (e.g. in_progress under a dead execution until the stale reset frees them).
const OUTSTANDING_POLL_MS = Number(process.env.SCREENING_POLL_MS ?? 15_000);
// A whole run gives up (marks 'partial', stops retrying) after this long --
// PROJECT_DEFAULT, justified against the ~2.8-3 minute theoretical
// Fyers-throughput floor for 501 instruments plus per-chunk overhead (~9
// chunks) plus room for 2-3 whole-chunk retries: a real ~2x margin over a
// realistic bad-but-recoverable run (~15-20 min), so only a genuinely stuck
// run (e.g. Fyers down all day, an expired token nobody rotated) ever gets
// given up on.
const MAX_TOTAL_RUN_DURATION_MS = Number(process.env.SCREENING_MAX_RUN_MINUTES ?? 40) * 60 * 1000;
// Originally 240s ("comfortably longer than one healthy chunk's own ~40-50s
// worst case"), but confirmed live on 2026-09-14 across two separate fresh
// runs (both for run_date 2026-09-11, same deterministically-seeded chunk
// order -- see shuffle.js) that a specific 60-instrument incremental chunk
// legitimately needs close to this original window just to finish its own
// serialized Fyers request queue (fyers.js's serializeFyersRequest allows
// only one Fyers HTTP call in flight per isolate at a time) -- both runs
// independently confirmed every one of that chunk's 60 instruments DID get
// a real, correct instrument_run_results row, just not before
// MAX_CHUNK_ATTEMPTS was exhausted via repeated premature resets, each
// costing a full stale-timeout window even when the still-live invocation
// was legitimately mid-chunk and would have finished on its own. Doubled to
// give a genuinely slow-but-healthy chunk real room to finish in fewer,
// less-interrupted attempts, rather than being raced away from underneath
// a still-working invocation.
const STALE_BATCH_AFTER_SECONDS = 480;
const MAX_CHUNK_ATTEMPTS = 3;
// 10 concurrent instrument evaluations per chunk: the shared Fyers rate
// limiter (providers/rate-limiter.js, 180/min) serializes the actual HTTP
// calls regardless of how many are "in flight" at once, so this only
// removes idle gaps between fetches/DB writes -- it can never make the
// pipeline exceed the provider's own cap.
const INSTRUMENT_CONCURRENCY = 10;
// Share of the universe (percent) whose ingestion may fail before the run is refused publication. 0 = none.
const MAX_INGESTION_FAILURE_PCT = Number(process.env.SCREENING_MAX_INGESTION_FAILURE_PCT ?? 0);

/**
 * Runs (or resumes) one EOD screening run to completion.
 * @param {{ db: import("../db/client.js").Db, chartStore: { putSvg(path: string, svg: string): Promise<void> },
 *           triggerType?: "manual"|"scheduled", triggeredBy?: string|null, resumeRunId?: string|null }} args
 * @returns {Promise<{ runId: string|null, status: string, note?: string }>}
 */
export async function runScreeningJob({ db: baseDb, chartStore, triggerType = "manual", triggeredBy = null, resumeRunId = null }) {
  // Chart uploads happen deep inside per-instrument evaluation; the job's
  // database handle carries the chart store so it reaches them without
  // threading a second argument through every signature.
  const db = { ...baseDb, chartStore };

  let runId = resumeRunId;
  if (!runId) {
    // Auditable recovery for abandoned historical runs. Six hours is far
    // beyond the 40-minute total-run budget, so a healthy run cannot be
    // expired by this sweep.
    const staleBoundary = new Date(Date.now() - 6 * 60 * 60 * 1000).toISOString();
    await db.query("select expire_stale_screening_runs($1::timestamptz)", [staleBoundary]);

    // Fresh run: acquire the lease under a brand-new id before creating
    // anything -- a single atomic UPDATE...WHERE...RETURNING (run-lease.js),
    // so there is no window where two concurrent executions can both see
    // "free" and both proceed.
    runId = crypto.randomUUID();
    const lease = await acquireRunLease(db, RUN_TYPE, runId, { leaseDurationMs: LEASE_DURATION_MS });
    if (!lease.acquired) {
      const activeLease = await db.one("select run_id, acquired_at from screening_run_leases where run_type = $1", [RUN_TYPE]);
      return {
        runId: activeLease?.run_id ?? null,
        status: "running",
        note: `A run (leased ${activeLease?.acquired_at ?? "recently"}) is already in progress; not starting another.`,
      };
    }

    const { runDate, asOfTimestamp } = freezeEodCutoff(new Date());
    const parameterVersion = await db.one("select * from parameter_versions order by created_at desc limit 1");
    const strategyVersions = await db.query("select id, framework from strategy_versions where is_active = true");
    const strategyVersionIds = strategyVersions.map((v) => v.id);

    await ops.insert(db, "screening_runs", {
      id: runId,
      run_date: runDate,
      as_of_timestamp: asOfTimestamp,
      mode: "EOD",
      status: "queued",
      publication_state: "processing",
      universe_version: UNIVERSE_VERSION,
      parameter_version_id: parameterVersion?.id ?? null,
      strategy_version_ids: strategyVersionIds,
      providers: { universe: "nse_archives", ohlcv: "fyers" },
      analysis_provider: "fyers",
      analysis_adjustment_state: FYERS_ADJUSTMENT_STATE,
      analysis_series_version: ANALYSIS_SERIES_VERSION,
      data_provenance: { analysisBars: FYERS_ADJUSTMENT_PROVENANCE },
      trigger_type: triggerType,
      triggered_by: triggeredBy,
      started_at: new Date().toISOString(),
    });
    await ops.insert(db, "pipeline_batches", { run_id: runId, stage: "universe", cursor: null, status: "pending" });
    await logStage(db, runId, "start", "ok", `Run started (${triggerType})`);
  } else {
    // Resuming: acquireRunLease's CAS matches status='released' regardless of
    // *why* it's released (a clean finish of the previous execution, or an
    // expired lease of a killed one) -- no special-casing needed here.
    const lease = await acquireRunLease(db, RUN_TYPE, runId, { leaseDurationMs: LEASE_DURATION_MS });
    if (!lease.acquired) {
      // Another execution got there first -- exactly the double-start case the
      // lease exists to resolve safely. Nothing more for this one to do.
      return { runId, status: "running", note: "Another execution is already running this run." };
    }
  }

  await runPipeline({ db: db, runId });
  const finished = await db.one("select status from screening_runs where id = $1", [runId]);
  return { runId, status: finished?.status ?? "unknown" };
}

/**
 * Runs `work` while periodically refreshing this invocation's own run lease
 * in the background (see LEASE_DURATION_MS / HEARTBEAT_INTERVAL_MS above) --
 * so a live invocation's lease freshness no longer depends on how long the
 * batch it's currently processing takes to resolve. The interval is always
 * cleared before returning, success or failure, so it can never fire after
 * this invocation has moved on (e.g. into the release-lease-and-self-chain
 * handoff).
 */
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

/**
 * Claims and processes pipeline_batches rows for `runId` one at a time until
 * none remain: the run is finished (or given up on after its total duration
 * cap). This execution holds the run lease, so any batch still "in_progress"
 * belongs to a dead execution and is freed by the stale reset at the top of
 * each loop iteration.
 */
async function runPipeline({ db, runId }) {
  try {
    const { data: run } = await ops.select(db, `select * from screening_runs
        where id = $1`, [runId], "single");
    if (!run) throw new Error(`screening_runs row not found for ${runId}`);
    const runStartedAtMs = new Date(run.started_at).getTime();

    // Pinned to the specific parameter/strategy versions this run started
    // with (stored on the run row at creation) -- not "whatever is
    // currently active," which could change mid-run across many
    // invocations and would otherwise make one run's own results
    // internally inconsistent.
    const { data: parameterVersion } = run.parameter_version_id
      ? await ops.select(db, `select * from parameter_versions
        where id = $1`, [run.parameter_version_id], "maybe")
      : { data: null };
    const parameterValues = flattenParameters(parameterVersion?.values ?? {});

    const { data: allRuleDefinitions } = run.strategy_version_ids?.length
      ? await ops.select(db, `select * from rule_definitions
        where strategy_version_id = any($1)`, [run.strategy_version_ids], "many")
      : { data: [] };
    const ruleDefinitions = filterScreeningRules(allRuleDefinitions);
    const ruleDirectionById = Object.fromEntries(ruleDefinitions.map((r) => [r.rule_id, r.direction]));

    for (;;) {
      const elapsedTotalMs = Date.now() - runStartedAtMs;

      const resetBatches = await db.query("select * from reset_stale_pipeline_batches($1::uuid, $2::integer, $3::integer)", [runId, STALE_BATCH_AFTER_SECONDS, MAX_CHUNK_ATTEMPTS]);
      for (const rb of resetBatches) {
        if (rb.status === "failed") {
          await recordGaveUpForBatch({
            db,
            runId,
            batch: rb,
            reason: `Chunk abandoned after ${rb.attempt} stale/stuck attempt(s) -- last claimed by an invocation that never finished`,
          });
        }
      }

      if (elapsedTotalMs > MAX_TOTAL_RUN_DURATION_MS) {
        await giveUpOnRun({ db, runId });
        break;
      }

      const claimedBatches = await db.query("select * from claim_next_pipeline_batch($1::uuid)", [runId]);
      const batch = claimedBatches[0] ?? null;
      if (!batch) {
        // claim_next_pipeline_batch() deliberately withholds reconcile while
        // any universe/incremental batch is still pending or in_progress
        // (see migration 0008) -- so "nothing claimable" does NOT by itself
        // mean the pipeline is stuck. A batch can be legitimately in_progress
        // under another concurrent invocation (or merely one recovery-sweep
        // tick away from its own stale-reset) when this invocation's claim
        // attempt lands. Only treat the run as genuinely stuck when there is
        // truly no outstanding (pending/in_progress) batch left anywhere for
        // it -- otherwise just yield and let a later invocation (self-chain
        // or the next sweep tick) pick up where things stand.
        const { data: outstanding } = await ops.select(db, `select id from pipeline_batches
        where run_id = $1
          and status = any($2)
        limit $3`, [runId, ["pending", "in_progress"], 1], "many");
        if (outstanding && outstanding.length > 0) {
          // Not claimable yet (in_progress under a dead execution, awaiting its
          // stale reset, or reconcile withheld) -- wait and re-check rather than
          // exit: this job is the only thing that would ever resume it.
          await sleep(OUTSTANDING_POLL_MS);
          continue;
        }
        // Normally reaching here with nothing outstanding means
        // processReconcileBatch already ran and finalized the run (reconcile
        // is the last stage, its own batch marked 'done' right after it
        // returns) -- but if reconcile itself permanently failed (exhausted
        // MAX_CHUNK_ATTEMPTS via the stale sweep above), nothing is ever
        // claimable again yet the run was never finalized either. Detect and
        // fix that directly rather than leaving the run stuck
        // 'running'/'queued' forever.
        const { data: freshRun } = await ops.select(db, `select status from screening_runs
        where id = $1`, [runId], "single");
        if (freshRun && (freshRun.status === "queued" || freshRun.status === "running")) {
          await logStage(db, runId, "reconcile_stuck", "warning", "No claimable or outstanding batch remained but the run was never finalized (likely the reconcile stage permanently failed) -- forcing partial.");
          await finalizeRunStatus({ db, runId, runStartedAtMs, forceStatus: "partial" });
        }
        break;
      }

      try {
        await withLeaseHeartbeat(db, runId, async () => {
          if (batch.stage === "universe") {
            await processUniverseBatch({ db, runId, runDate: run.run_date });
          } else if (batch.stage === "incremental") {
            await processIncrementalBatch({
              db,
              runId,
              runDate: run.run_date,
              asOfTimestamp: run.as_of_timestamp,
              batch,
              parameterValues,
              ruleDefinitions: ruleDefinitions ?? [],
              ruleDirectionById,
            });
          } else if (batch.stage === "backfill") {
            await processBackfillBatch({ db, batch, asOfTimestamp: run.as_of_timestamp });
          } else if (batch.stage === "reconcile") {
            await processReconcileBatch({ db, runId, runStartedAtMs });
          }
        });
        await ops.update(db, "pipeline_batches", { status: "done", updated_at: new Date().toISOString() }, { id: batch.id });
      } catch (err) {
        if (err instanceof FyersAuthError) throw err; // abort with the clear cause; retrying batches cannot fix an expired token
        const message = err instanceof Error ? err.message : String(err);
        const gaveUp = batch.attempt >= MAX_CHUNK_ATTEMPTS;
        await ops.update(db, "pipeline_batches", { status: gaveUp ? "failed" : "pending", last_error: message, updated_at: new Date().toISOString() }, { id: batch.id });
        await logStage(
          db,
          runId,
          "batch_error",
          "warning",
          `batch ${batch.id} (${batch.stage}) attempt ${batch.attempt} ${gaveUp ? "gave up" : "will retry"}: ${message}`
        );
        if (gaveUp) {
          await recordGaveUpForBatch({ db, runId, batch, reason: `Chunk failed ${batch.attempt}x, last error: ${message}` });
        }
      }

      await heartbeatRunLease(db, RUN_TYPE, runId, { leaseDurationMs: LEASE_DURATION_MS });
    }
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    await logStage(db, runId, "error", "failed", message);
    await ops.update(db, "screening_runs", { status: "failed", completed_at: new Date().toISOString() }, { id: runId });
    // An expired FYERS token fails the JOB (non-zero exit, clear message) so it is
    // impossible to miss; other failures are recorded on the run and end the loop.
    if (err instanceof FyersAuthError) throw err;
  } finally {
    await releaseRunLease(db, RUN_TYPE, runId);
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
async function giveUpOnRun({ db, runId }) {
  const { data: stuckBatches } = await ops.update(db, "pipeline_batches", { status: "failed", last_error: `Run exceeded its ${Math.round(MAX_TOTAL_RUN_DURATION_MS / 60000)}-minute total duration cap`, updated_at: new Date().toISOString() }, { run_id: runId, status: { in: ["pending", "in_progress"] } }, { returning: ["stage", "cursor", "attempt"] });

  for (const batch of stuckBatches ?? []) {
    await recordGaveUpForBatch({
      db,
      runId,
      batch,
      reason: `Run exceeded its ${Math.round(MAX_TOTAL_RUN_DURATION_MS / 60000)}-minute total duration cap before this chunk could be attempted`,
    });
  }

  await logStage(db, runId, "time_budget", "warning", `Run exceeded its total duration cap with ${(stuckBatches ?? []).length} batch(es) never resolved`);
  await finalizeRunStatus({ db, runId, forceStatus: "partial" });
}

/**
 * Inserts honest "gave up" terminal rows for any instrument in `batch`'s own
 * cursor that still has no instrument_run_results row -- used both when a
 * chunk permanently fails (exhausted retries, live or via the stale sweep)
 * and when a whole run gives up. No-op for non-'incremental' stages
 * (backfill/universe/reconcile never produce instrument_run_results rows
 * themselves).
 */
async function recordGaveUpForBatch({ db, runId, batch, reason }) {
  if (batch.stage !== "incremental" || !batch.cursor) return;
  const instruments = JSON.parse(batch.cursor);
  const { data: existingResults } = await ops.select(db, `select instrument_id from instrument_run_results
        where run_id = $1
          and instrument_id = any($2)`, [runId, instruments.map((i) => i.instrumentId)], "many");
  const doneIds = new Set((existingResults ?? []).map((r) => r.instrument_id));
  const missing = instruments.filter((i) => !doneIds.has(i.instrumentId));
  if (missing.length > 0) {
    await recordGaveUpBulk({ db, runId, instruments: missing, reason });
  }
}

/** Bulk, idempotent (upsert) insert of honest terminal rows -- never the old "ran out of time" wording; `reason` must state what actually happened. */
async function recordGaveUpBulk({ db, runId, instruments, reason }) {
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
  const { error: resultError } = await ops.upsert(db, "instrument_run_results", resultRows, { conflict: ["run_id", "instrument_id"] });
  if (resultError) throw resultError;
  const { error: qualityError } = await ops.insert(db, "data_quality_results", qualityRows);
  if (qualityError) throw qualityError;
  const { error: alignmentError } = await ops.upsert(db, "instrument_alignment", instruments.map((instrument) => ({
      run_id: runId,
      instrument_id: instrument.instrumentId,
      final_alignment: "UNAVAILABLE",
      computed_at: new Date().toISOString(),
    })), { conflict: ["run_id", "instrument_id"] });
  if (alignmentError) throw alignmentError;
  return resultRows;
}

/**
 * The 'universe' stage: builds this run's instrument/index-membership set
 * (unchanged logic, buildUniverse below), then -- only the first time this
 * succeeds for the run (idempotent guard, since a retried universe batch
 * must not re-seed and duplicate every other batch) -- seeds every
 * 'incremental'/'backfill'/'reconcile' pipeline_batches row.
 */
async function processUniverseBatch({ db, runId, runDate }) {
  const membership = await buildUniverse(db, runId, runDate);
  await logStage(db, runId, "universe", "ok", `${INDEX_IDS.length} indexes, ${membership.size} unique constituents`);

  // Idempotent guard against a retry of this SAME batch (crashed after
  // buildUniverse but before finishing the seeding below): the 'reconcile'
  // row is inserted last, so its existence is the definitive "fully seeded"
  // marker. If a retry gets past this check, the incremental/backfill rows
  // below are upserted (not inserted) specifically so re-seeding after a
  // partial prior attempt never collides with rows that already made it in.
  const { data: existingReconcile } = await ops.select(db, `select id from pipeline_batches
        where run_id = $1
          and stage = $2`, [runId, "reconcile"], "maybe");
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
    const { data: barred } = await ops.select(db, `select instrument_id from market_bars_raw
        where interval = $1
          and instrument_id = any($2)`, ["1d", nonIndexIds], "many");
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
    await ops.upsert(db, "pipeline_batches", rowsToInsert, { conflict: ["run_id", "stage", "cursor"], ignoreDuplicates: true });
  }
  await ops.insert(db, "pipeline_batches", { run_id: runId, stage: "reconcile", cursor: null, status: "pending" });
  await ops.update(db, "screening_runs", { status: "running" }, { id: runId, status: "queued" });
}

/**
 * The 'incremental' stage: this chunk's instruments, minus whichever
 * already have a real instrument_run_results row for this run (idempotent
 * retry -- no wasted Fyers requests re-attempting already-done work),
 * evaluated with INSTRUMENT_CONCURRENCY-bounded concurrency.
 */
async function processIncrementalBatch({ db, runId, runDate, asOfTimestamp, batch, parameterValues, ruleDefinitions, ruleDirectionById }) {
  const instruments = JSON.parse(batch.cursor);
  const { data: alreadyDone } = await ops.select(db, `select instrument_id from instrument_run_results
        where run_id = $1
          and instrument_id = any($2)`, [runId, instruments.map((i) => i.instrumentId)], "many");
  const doneSet = new Set((alreadyDone ?? []).map((r) => r.instrument_id));
  const remaining = instruments.filter((i) => !doneSet.has(i.instrumentId));

  await runWithConcurrencyLimit(remaining, INSTRUMENT_CONCURRENCY, (instrument) =>
    evaluateInstrument({ db, runId, runDate, asOfTimestamp, instrument, ruleDefinitions, parameterValues, ruleDirectionById })
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
async function processBackfillBatch({ db, batch, asOfTimestamp }) {
  const instruments = JSON.parse(batch.cursor);
  await runWithConcurrencyLimit(instruments, INSTRUMENT_CONCURRENCY, async (instrument) => {
    const { data: existing } = await ops.select(db, `select session_date from market_bars_raw
        where instrument_id = $1
          and interval = $2
        limit $3`, [instrument.instrumentId, "1d", 1], "maybe");
    if (existing) return;

    let to = new Date(asOfTimestamp);
    let allBars = [];
    for (let leg = 0; leg < MAX_BACKFILL_LEGS; leg++) {
      const from = new Date(to.getTime() - BACKFILL_LEG_DAYS * 24 * 60 * 60 * 1000);
      let legBars;
      try {
        const ohlcv = await fetchOHLCVRange(instrument.instrumentId, instrument.symbol, from, to, db);
        legBars = ohlcv.data;
      } catch (err) {
        if (err instanceof FyersAuthError) throw err; // an expired token is not a 'no more history' signal
        break; // best-effort -- keep whatever earlier legs already fetched
      }
      if (legBars.length === 0) break; // no more history available this far back
      allBars = allBars.concat(legBars);
      to = from;
    }
    if (allBars.length > 0) {
      await writeRawBars(db, instrument.instrumentId, allBars);
    }
  });
}

/** The 'reconcile' stage: ranking, coverage, and the run's final status -- see finalizeRunStatus. */
async function processReconcileBatch({ db, runId, runStartedAtMs }) {
  await finalizeRunStatus({ db, runId, runStartedAtMs });
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
async function finalizeRunStatus({ db, runId, runStartedAtMs, forceStatus }) {
  const { data: incrementalBatches } = await ops.select(db, `select cursor from pipeline_batches
        where run_id = $1
          and stage = $2`, [runId, "incremental"], "many");
  const universeCount = uniqueInstrumentsFromCursors(incrementalBatches ?? []).length;

  const { data: stockResults } = await ops.select(db, `select instrument_id, tier, direction, score, component_scores from instrument_run_results
        where run_id = $1
          and is_index = $2`, [runId, false], "many");
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
  await ops.remove(db, "rankings", { run_id: runId });
  if (ranked.length > 0) {
    await ops.insert(db, "rankings", ranked.map((r) => ({
        run_id: runId,
        instrument_id: r.instrumentId,
        direction: r.direction,
        tier: r.tier,
        total_score: r.score,
        component_scores: r.componentScores,
        rank_within_tier: r.rankWithinTier,
      })));
  }

  const coverage = reconcileCoverage(rows.map((r) => ({ tier: r.tier })), universeCount);
  const { error: coverageError } = await ops.upsert(db, "coverage_reconciliation", { run_id: runId, ...coverage }, { conflict: ["run_id"] });
  if (coverageError) throw coverageError;

  let status = forceStatus;
  if (!status) {
    const { data: batches } = await ops.select(db, `select stage, status from pipeline_batches
        where run_id = $1`, [runId], "many");
    status = decideRunStatus({
      batches: batches ?? [],
      universeCount,
      resultCount: rows.length,
      elapsedMs: Date.now() - runStartedAtMs,
      maxDurationMs: MAX_TOTAL_RUN_DURATION_MS,
    });
  }

  // Publication gate: a snapshot is built from freshly ingested data, so a run in which ingestion FAILED for
  // instruments (provider errors, recorded as data_quality 'ingestion' rows -- as opposed to an instrument that
  // legitimately has no data) must not be published as if it were complete. It stays 'partial'/validation_failed,
  // visible to staff, and a later run is safe (bars are upserted, so re-fetching is idempotent).
  if (status === "ready_to_publish") {
    const failedIngestion = await db.one(
      "select count(distinct instrument_id)::int as n from data_quality_results where run_id = $1 and check_name = 'ingestion'",
      [runId],
    );
    const allowed = Math.floor((universeCount * MAX_INGESTION_FAILURE_PCT) / 100);
    if (failedIngestion.n > allowed) {
      await logStage(
        db,
        runId,
        "publication_blocked",
        "warning",
        `${failedIngestion.n} instrument(s) failed ingestion (allowed: ${allowed}); the snapshot is NOT published. Fix the provider issue and re-run.`,
      );
      status = "partial";
    }
  }

  if (status === "ready_to_publish") {
    // Validates the frozen snapshot transactionally and publishes it (raises on failure).
    const { publication } = await db.one("select publish_screening_run($1::uuid) as publication", [runId]);
    const published = publication?.published === true;
    await logStage(
      db,
      runId,
      "publication",
      published ? "ok" : "warning",
      published
        ? `Published validated snapshot: universeCount=${universeCount} resultCount=${rows.length}`
        : `Publication validation failed: ${(publication?.errors ?? []).join("; ")}`
    );
    return;
  }

  const isTerminal = status === "partial" || status === "failed";
  const { error: statusError } = await ops.update(db, "screening_runs", {
      status,
      publication_state: isTerminal ? "validation_failed" : "processing",
      completed_at: isTerminal ? new Date().toISOString() : null,
    }, { id: runId });
  if (statusError) throw statusError;
  await logStage(db, runId, "complete", status === "completed" ? "ok" : "warning", `status=${status} universeCount=${universeCount} resultCount=${rows.length}`);
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

async function buildUniverse(db, runId, runDate) {
  // Idempotent-retry guard: a crash between buildUniverse's own writes and
  // processUniverseBatch's "reconcile" seeding marker causes this function to
  // be called again for the SAME run. Without this check it would re-fetch
  // live NSE data and overwrite the first attempt's run_universe_sources
  // content_hash/retrieved_at -- silently un-freezing what is documented as
  // an immutable, run-scoped snapshot (a same-day NSE constituent change
  // between the two fetches would make the retried snapshot disagree with
  // the first). Once all 4 index sources are already persisted for this
  // run_id, reconstruct membership from those persisted rows instead of
  // fetching again.
  const { data: existingSources, error: existingSourcesError } = await ops.select(db, `select index_id from run_universe_sources
        where run_id = $1`, [runId], "many");
  if (existingSourcesError) throw existingSourcesError;
  if (existingSources && existingSources.length === INDEX_IDS.length) {
    const { data: existingMembers, error: membersError } = await ops.select(db, `select instrument_id, membership_tags from run_universe_instruments
        where run_id = $1
          and is_index = $2`, [runId, false], "many");
    if (membersError) throw membersError;
    const instrumentIds = (existingMembers ?? []).map((m) => m.instrument_id);
    const { data: instrumentRows, error: instrumentsError } = instrumentIds.length
      ? await ops.select(db, `select id, symbol, name from instruments
        where id = any($1)`, [instrumentIds], "many")
      : { data: [], error: null };
    if (instrumentsError) throw instrumentsError;
    const byId = new Map((instrumentRows ?? []).map((row) => [row.id, row]));
    const membership = new Map();
    for (const m of existingMembers ?? []) {
      const inst = byId.get(m.instrument_id);
      membership.set(m.instrument_id, {
        symbol: inst?.symbol ?? m.instrument_id,
        name: inst?.name ?? m.instrument_id,
        indexIds: new Set(m.membership_tags ?? []),
      });
    }
    return membership;
  }

  const membership = new Map(); // instrumentId -> { symbol, name, indexIds: Set }
  const sourceSnapshots = [];
  const sourceErrors = [];

  for (const indexId of INDEX_IDS) {
    try {
      const snapshot = await fetchIndexConstituents(indexId);
      const constituents = snapshot.data;
      sourceSnapshots.push({ indexId, ...snapshot });
      for (const c of constituents) {
        if (!membership.has(c.instrumentId)) {
          membership.set(c.instrumentId, { symbol: c.symbol, name: c.name, indexIds: new Set() });
        }
        membership.get(c.instrumentId).indexIds.add(indexId);
      }
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      sourceErrors.push(`${indexId}: ${message}`);
      await logStage(db, runId, "universe", "failed", `${indexId} constituent fetch failed: ${message}`);
    }
  }

  if (sourceSnapshots.length !== INDEX_IDS.length) {
    throw new Error(`Immutable universe snapshot incomplete (${sourceSnapshots.length}/${INDEX_IDS.length} indexes): ${sourceErrors.join(" | ")}`);
  }
  if (membership.size === 0) throw new Error("Immutable universe snapshot contains zero equities");

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
    const { error } = await ops.upsert(db, "instruments", instrumentRows, { conflict: ["id"] });
    if (error) throw error;
  }

  const { error: sourceError } = await ops.upsert(db, "run_universe_sources", sourceSnapshots.map((snapshot) => ({
      run_id: runId,
      index_id: snapshot.indexId,
      provider: snapshot.provider,
      retrieved_at: snapshot.retrievedAt,
      constituent_count: snapshot.data.length,
      source_uri: snapshot.sourceUri,
      content_hash: snapshot.contentHash,
    })), { conflict: ["run_id", "index_id"] });
  if (sourceError) throw sourceError;

  const { error: universeError } = await ops.upsert(db, "run_universe_instruments", [
      ...INDEX_IDS.map((id) => ({ run_id: runId, instrument_id: id, is_index: true, membership_tags: [] })),
      ...[...membership.entries()].map(([id, member]) => ({
        run_id: runId,
        instrument_id: id,
        is_index: false,
        membership_tags: [...member.indexIds].sort(),
      })),
    ], { conflict: ["run_id", "instrument_id"] });
  if (universeError) throw universeError;

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
    await ops.upsert(db, "index_memberships", membershipRows, { conflict: ["index_id", "instrument_id", "effective_date"] });
  }

  // Closes a previously-flagged gap: a constituent this run's fetch didn't
  // see for a given index is no longer current, but nothing before this
  // ever retired its earlier is_current row -- they'd accumulate forever.
  for (const indexId of INDEX_IDS) {
    const currentIds = new Set([...membership.entries()].filter(([, m]) => m.indexIds.has(indexId)).map(([id]) => id));
    const { data: existingMembers } = await ops.select(db, `select instrument_id from index_memberships
        where index_id = $1
          and is_current = $2`, [indexId, true], "many");
    const staleIds = (existingMembers ?? []).map((r) => r.instrument_id).filter((id) => !currentIds.has(id));
    if (staleIds.length > 0) {
      await ops.update(db, "index_memberships", { is_current: false }, { index_id: indexId, instrument_id: { in: staleIds } });
    }
  }

  return membership;
}

/** Upserts fetched daily bars, trying migration 0006's interval-aware shape first and falling back to the pre-migration shape if that column set doesn't exist yet. No-op on an empty array. */
async function writeRawBars(db, instrumentId, bars) {
  if (bars.length === 0) return;
  const rawBars = bars.map((b) => ({
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
  await ops.upsert(db, "market_bars_raw", rawBars, { conflict: ["instrument_id", "interval", "ts", "provider"] });
}

async function persistAnalysisBars({ db, runId, instrumentId, series }) {
  if (series.bars.length === 0) return;
  const rows = series.bars.map((bar) => ({
    run_id: runId,
    instrument_id: instrumentId,
    interval: series.interval,
    session_date: bar.sessionDate ?? bar.date.slice(0, 10),
    ts: bar.ts ?? `${bar.date}T00:00:00+05:30`,
    open: bar.open,
    high: bar.high,
    low: bar.low,
    close: bar.close,
    volume: bar.volume,
    provider: series.provider,
    adjustment_state: series.adjustmentState,
    algorithm_version: series.algorithmVersion,
    provenance: series.provenance,
    is_complete: bar.isComplete ?? true,
    source_retrieved_at: bar.sourceRetrievedAt ?? null,
  }));
  const { error } = await ops.upsert(db, "analysis_bars", rows, { conflict: ["run_id", "instrument_id", "interval", "ts"] });
  if (error) throw error;
}

async function persistUnavailableAlignment(db, runId, instrumentId) {
  const { error } = await ops.upsert(db, "instrument_alignment", { run_id: runId, instrument_id: instrumentId, final_alignment: "UNAVAILABLE", computed_at: new Date().toISOString() }, { conflict: ["run_id", "instrument_id"] });
  if (error) throw error;
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
async function evaluateInstrument({ db, runId, runDate, asOfTimestamp, instrument, ruleDefinitions, parameterValues, ruleDirectionById }) {
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
    const { data: latestBar } = await ops.select(db, `select session_date from market_bars_raw
        where instrument_id = $1
          and interval = $2
        order by session_date desc
        limit $3`, [instrument.instrumentId, "1d", 1], "maybe");

    const range = nextIncrementalRange(latestBar?.session_date ?? null, runDate, OHLCV_LOOKBACK_DAYS);
    if (range) {
      const ohlcv = await fetchOHLCVRange(instrument.instrumentId, instrument.symbol, range.from, range.to, db);
      await writeRawBars(db, instrument.instrumentId, ohlcv.data);
    }

    const windowStartDate = new Date(new Date(`${runDate}T00:00:00Z`).getTime() - OHLCV_LOOKBACK_DAYS * 24 * 60 * 60 * 1000)
      .toISOString()
      .slice(0, 10);
    const { data: storedBars, error: readError } = await ops.select(db, `select session_date, ts, open, high, low, close, volume, provider, retrieved_at, is_complete from market_bars_raw
        where instrument_id = $1
          and interval = $2
          and provider = $3
          and session_date >= $4
          and session_date <= $5
        order by session_date asc`, [instrument.instrumentId, "1d", "fyers", windowStartDate, runDate], "many");
    if (readError) throw readError;

    bars = (storedBars ?? []).map((b) => ({
      date: b.session_date,
      ts: b.ts,
      open: b.open,
      high: b.high,
      low: b.low,
      close: b.close,
      volume: b.volume,
      sourceRetrievedAt: b.retrieved_at,
      isComplete: b.is_complete,
    }));
    const validation = validateBars(bars, { asOfTimestamp, cutoffDate: runDate });
    dataQuality = validation.result;
    if (validation.issues.length > 0) {
      const { error: qualityError } = await ops.insert(db, "data_quality_results", {
        run_id: runId,
        instrument_id: instrument.instrumentId,
        check_name: "bar_validation",
        result: dataQuality,
        details: { issues: validation.issues.slice(0, 20) },
      });
      if (qualityError) throw qualityError;
    }
  } catch (err) {
    // An expired/invalid FYERS token must stop the run with its clear cause, not be
    // recorded as a per-instrument "no data" result for the whole universe.
    if (err instanceof FyersAuthError) throw err;
    const { error: ingestionQualityError } = await ops.insert(db, "data_quality_results", {
      run_id: runId,
      instrument_id: instrument.instrumentId,
      check_name: "ingestion",
      result: "NO_DATA",
      details: { error: err instanceof Error ? err.message : String(err) },
    });
    if (ingestionQualityError) throw ingestionQualityError;
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
    const { error: resultError } = await ops.upsert(db, "instrument_run_results", resultRow, { conflict: ["run_id", "instrument_id"] });
    if (resultError) throw resultError;
    await persistUnavailableAlignment(db, runId, instrument.instrumentId);
    return { resultRow };
  }

  // FYERS History already adjusts both price and volume for corporate
  // actions. This explicit run-scoped series is the sole downstream input;
  // applying corporate_actions again would double-adjust it.
  const analysisSeries = buildAnalysisBars({ bars, provider: "fyers", interval: "1d", asOfTimestamp });
  await persistAnalysisBars({ db, runId, instrumentId: instrument.instrumentId, series: analysisSeries });
  bars = analysisSeries.bars;

  // Idempotent-retry cleanup: clear this instrument's own prior
  // bar_validation/rule_traces rows for this run before rewriting them,
  // closing the narrow window where a process died after those writes but
  // before the instrument_run_results row below (which is what the
  // idempotent-skip filter upstream actually checks).
  await Promise.all([
    ops.remove(db, "data_quality_results", { run_id: runId, instrument_id: instrument.instrumentId, check_name: "bar_validation" }),
    ops.remove(db, "rule_traces", { run_id: runId, instrument_id: instrument.instrumentId }),
  ]);

  // Direction analysis (writes instrument_direction* / pattern_detections /
  // instrument_alignment) and rule evaluation (writes rule_traces) both only
  // need `bars` -- neither reads the other's output, so they run
  // concurrently rather than one blocking the other's network round trips.
  const [directionArtifacts, { traces, failedGates }] = await Promise.all([
    (async () => {
      try {
        return await upsertDirectionAnalysis({ db, runId, instrument, bars, documentedParams: parameterValues.documented ?? {} });
      } catch (err) {
        await recordCriticalPersistenceError(db, runId, instrument.instrumentId, "direction_analysis", err);
        await logStage(
          db,
          runId,
          "direction_chart",
          "warning",
          `${instrument.instrumentId}: direction analysis failed: ${err instanceof Error ? err.message : String(err)}`
        );
        return { chartsByTimeframe: {} };
      }
    })(),
    (async () => {
      const context = buildFeatureContext(bars, parameterValues.documented ?? {});
      const result = evaluateRules(ruleDefinitions, context, parameterValues);
      if (result.traces.length > 0) {
        const { error: traceError } = await ops.insert(db, "rule_traces", result.traces.map((t) => ({ run_id: runId, instrument_id: instrument.instrumentId, ...t })));
        if (traceError) throw traceError;
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
        db,
        runId,
        asOfTimestamp,
        instrument,
        dailyBars: bars,
        parameterValues: parameterValues.documented ?? {},
        bullishQualifiesForHourly,
        bearishQualifiesForHourly,
      });
    } catch (err) {
      if (err instanceof FyersAuthError) throw err;
      await recordCriticalPersistenceError(db, runId, instrument.instrumentId, "hourly_ingest", err);
      await logStage(
        db,
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
    await persistSwingAnalysisResults({
      db,
      runId,
      instrument,
      traces,
      routeEvidence,
      directionCharts: directionArtifacts.chartsByTimeframe,
      dailyBars: bars,
      parameterValues: parameterValues.documented ?? {},
    });
  } catch (err) {
    await recordCriticalPersistenceError(db, runId, instrument.instrumentId, "swing_analysis", err);
    await logStage(
      db,
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
  const { error: resultError } = await ops.upsert(db, "instrument_run_results", resultRow, { conflict: ["run_id", "instrument_id"] });
  if (resultError) throw resultError;

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
async function persistSwingAnalysisResults({ db, runId, instrument, traces, routeEvidence, directionCharts, dailyBars, parameterValues }) {
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

    const evidenceTimestamp = new Date().toISOString();

    const { data: resultRow, error: resultError } = await ops.upsert(db, "swing_analysis_results", {
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
          daily_chart_object_path: directionCharts?.daily?.objectPath ?? null,
          daily_chart_content_hash: directionCharts?.daily?.contentHash ?? null,
          hourly_chart_object_path: routeEvidence?.hourlyChart?.objectPath ?? null,
          hourly_chart_content_hash: routeEvidence?.hourlyChart?.contentHash ?? null,
          computed_at: evidenceTimestamp,
        }, { conflict: ["run_id", "instrument_id", "hypothesis"], returning: ["id"], mode: "single" });

    if (resultError) throw resultError;

    const gatePrefix = hypothesis === "bullish" ? "WBP-" : "WSP-";
    const gateTraces = analysis.canonicalGateTraces.map(toPersistedSwingTrace);

    const [{ error: swingTraceDeleteError }, { error: ruleTraceDeleteError }] = await Promise.all([
      ops.remove(db, "swing_analysis_rule_traces", { analysis_result_id: resultRow.id }),
      db
        .query("delete from rule_traces where run_id = $1 and instrument_id = $2 and rule_id like $3", [runId, instrument.instrumentId, `${gatePrefix}%`])
        .then(() => ({ error: null })),
    ]);
    if (swingTraceDeleteError) throw swingTraceDeleteError;
    if (ruleTraceDeleteError) throw ruleTraceDeleteError;

    if (gateTraces.length > 0) {
      const [swingTraceInsert, ruleTraceInsert] = await Promise.all([
        ops.insert(db, "swing_analysis_rule_traces", gateTraces.map((t) => ({
            analysis_result_id: resultRow.id,
            rule_id: t.rule_id,
            group_name: null,
            result: t.result,
            observed_values: t.observed_values,
            thresholds: t.thresholds,
            explanation: t.explanation,
            source_locator: t.source_locator,
            required_condition:
              t.thresholds && Object.keys(t.thresholds).length > 0
                ? JSON.stringify(t.thresholds)
                : "Apply the documented condition at the cited source locator.",
            evidence_timestamp: evidenceTimestamp,
            data_quality: t.result === "NO_DATA" ? "NO_DATA" : "PASS",
          }))),
        ops.insert(db, "rule_traces", gateTraces.map((t) => ({
            run_id: runId,
            instrument_id: instrument.instrumentId,
            rule_id: t.rule_id,
            observed_values: t.observed_values,
            thresholds: t.thresholds,
            result: t.result,
            source_document: t.source_locator?.split(" §")[0] ?? null,
            source_locator: t.source_locator,
            explanation: t.explanation,
          }))),
      ]);
      if (swingTraceInsert.error) throw swingTraceInsert.error;
      if (ruleTraceInsert.error) throw ruleTraceInsert.error;
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
async function ingestHourlyBarsAndDetectRoutes({ db, runId, asOfTimestamp, instrument, dailyBars, parameterValues, bullishQualifiesForHourly, bearishQualifiesForHourly }) {
  const { data: rawCandles, retrievedAt } = await fetchHourlyOHLCV(instrument.instrumentId, instrument.symbol, db, { asOfTimestamp });
  const hourlyBars = normalizeCompletedHourlyBars(rawCandles, asOfTimestamp).map((bar) => ({ ...bar, sourceRetrievedAt: retrievedAt }));
  if (hourlyBars.length === 0) return null;

  const analysisSeries = buildAnalysisBars({ bars: hourlyBars, provider: "fyers", interval: "1h", asOfTimestamp });
  await persistAnalysisBars({ db, runId, instrumentId: instrument.instrumentId, series: analysisSeries });

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
  const { error } = await ops.upsert(db, "market_bars_raw", rows, { conflict: ["instrument_id", "interval", "ts", "provider"] });
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
  const hourlyDowStructure = classifyDowStructure(hourlyPivots, hourlyBars[hourlyBars.length - 1].close);
  let hourlyChart = null;
  try {
    const hourlySvg = renderChartSvg({
      symbol: instrument.symbol,
      timeframe: "hourly",
      bars: hourlyBars,
      pivots: hourlyPivots,
      wave: null,
      dowState: hourlyDowStructure.state,
    });
    hourlyChart = await uploadImmutableChart({
      db,
      instrumentId: instrument.instrumentId,
      timeframe: "hourly",
      svg: hourlySvg,
    });
  } catch (err) {
    await recordCriticalPersistenceError(db, runId, instrument.instrumentId, "hourly_chart", err);
    await logStage(
      db,
      runId,
      "hourly_chart",
      "warning",
      `${instrument.instrumentId}: immutable hourly chart upload failed: ${err instanceof Error ? err.message : String(err)}`
    );
  }

  const macdFast = parameterValues.macd_fast;
  const macdSlow = parameterValues.macd_slow;
  const macdSignal = parameterValues.macd_signal;
  const macdParamsResolved = macdFast != null && macdSlow != null && macdSignal != null;
  const dailyMacdHistogramPhase = macdParamsResolved ? macdHistogramPhase(dailyBars.map((b) => b.close), macdFast, macdSlow, macdSignal, 4) : { change: null, priorPhase: null };
  const weeklyMacdHistogramChange = macdParamsResolved ? macdHistogramPhase(aggregateBars(dailyBars, "weekly").map((b) => b.close), macdFast, macdSlow, macdSignal, 4).change : null;

  const bodySizeMultiplier = parameterValues.rounding_pattern_body_size_multiplier;
  const papaFormationsFor = (bullish) => detectTriggeredPapaFormations({ hourlyBars, hourlyPivots, dailyPivots, bullish, bodySizeMultiplier });
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
    hourlyChart,
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
async function upsertDirectionAnalysis({ db, runId, instrument, bars, documentedParams }) {
  const analysis = await buildDirectionAnalysis(bars, documentedParams);

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

      const svg = renderChartSvg({
        symbol: instrument.symbol,
        timeframe,
        bars: tf.bars,
        pivots: tf.pivots,
        unconfirmedLeg: tf.unconfirmedLeg,
        wave: tf.wave,
        dowState: tf.dowState,
      });
      const { objectPath, contentHash } = await uploadImmutableChart({
        db,
        instrumentId: instrument.instrumentId,
        timeframe,
        svg,
      });

      const { error: latestDirectionError } = await ops.upsert(db, "instrument_direction", {
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
        }, { conflict: ["instrument_id", "timeframe"] });
      if (latestDirectionError) throw latestDirectionError;

      // Run-scoped schema: instrument_direction above is latest-state only
      // and gets overwritten every run, so it can never answer "what did we
      // actually see on run X" -- these tables are this run's immutable
      // evidence. Failure here must never block the legacy row above (still
      // what the live Direction page reads) or pattern detection below.
      try {
        await persistDirectionRun({ db, runId, instrument, timeframe, tf, objectPath, contentHash });
      } catch (err) {
        await logStage(
          db,
          runId,
          "direction_run",
          "warning",
          `${instrument.instrumentId}/${timeframe}: run-scoped direction/wave persistence failed: ${err instanceof Error ? err.message : String(err)}`
        );
        await recordCriticalPersistenceError(db, runId, instrument.instrumentId, "direction_run", err);
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
        patterns = await persistPatternDetections({ db, runId, instrument, timeframe, hits });
      } catch (err) {
        // persistence failed -- hits are still usable for alignment, just without a DB id per hit
        await logStage(
          db,
          runId,
          "pattern_detection",
          "warning",
          `${instrument.instrumentId}/${timeframe}: pattern detection persistence failed: ${err instanceof Error ? err.message : String(err)}`
        );
        await recordCriticalPersistenceError(db, runId, instrument.instrumentId, "pattern_detection", err);
      }

      return { timeframe, patterns, objectPath, contentHash };
    })
  );

  const successfulResults = perTimeframeResults.filter(Boolean);
  const patternsByTimeframe = Object.fromEntries(successfulResults.map((result) => [result.timeframe, result.patterns]));
  const chartsByTimeframe = Object.fromEntries(
    successfulResults.map((result) => [result.timeframe, { objectPath: result.objectPath, contentHash: result.contentHash }])
  );

  // final_alignment (#1, #6): combines SMM (all 3 timeframes' dow_state),
  // GUE (disclosed but non-authoritative, see alignment.js), and PAPA
  // (a TRIGGERED opposing pattern downgrades to MANUAL_REVIEW) into one
  // server-side call -- never derived in the browser from raw dow_state
  // strings again.
  try {
    await persistFinalAlignment({ db, runId, instrument, analysis, patternsByTimeframe });
  } catch (err) {
    await logStage(
      db,
      runId,
      "final_alignment",
      "warning",
      `${instrument.instrumentId}: final_alignment computation/persistence failed: ${err instanceof Error ? err.message : String(err)}`
    );
    await recordCriticalPersistenceError(db, runId, instrument.instrumentId, "final_alignment", err);
  }
  return { chartsByTimeframe };
}

async function uploadImmutableChart({ db, instrumentId, timeframe, svg }) {
  const identity = await immutableChartIdentity(instrumentId, timeframe, svg);
  await db.chartStore.putSvg(identity.objectPath, svg); // immutable: an identical existing object is success
  return identity;
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
async function persistDirectionRun({ db, runId, instrument, timeframe, tf, objectPath, contentHash }) {
  const directionalLevel = trendDefiningLevelFor(tf.dowState, tf.lastSwingHigh, tf.lastSwingLow);

  const { error: runError } = await ops.upsert(db, "instrument_direction_runs", {
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
      chart_content_hash: contentHash,
      chart_algorithm_version: DIRECTION_ALGORITHM_VERSION,
      chart_renderer_version: RENDER_VERSION,
      data_quality: "PASS",
      computed_at: new Date().toISOString(),
    }, { conflict: ["run_id", "instrument_id", "timeframe"] });
  if (runError) throw runError;

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
    const { error: pivotError } = await ops.insert(db, "direction_pivots", pivotRows);
    if (pivotError) throw pivotError;
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
    const { error: waveError } = await ops.insert(db, "elliott_hypotheses", hypothesisRows);
    if (waveError) throw waveError;
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
async function persistPatternDetections({ db, runId, instrument, timeframe, hits }) {
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

  const { data: inserted, error } = await ops.insert(db, "pattern_detections", rows, { returning: ["id"] });
  if (error) {
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
async function persistFinalAlignment({ db, runId, instrument, analysis, patternsByTimeframe }) {
  const alignment = computeFinalAlignment(analysis, patternsByTimeframe);

  const bearishPatternId =
    alignment.opposingTriggeredPattern?.direction === "bearish" ? findPatternId(patternsByTimeframe, alignment.opposingTriggeredPattern) : null;
  const bullishPatternId =
    alignment.opposingTriggeredPattern?.direction === "bullish" ? findPatternId(patternsByTimeframe, alignment.opposingTriggeredPattern) : null;

  const { error } = await ops.upsert(db, "instrument_alignment", {
      run_id: runId,
      instrument_id: instrument.instrumentId,
      final_alignment: alignment.finalAlignment,
      triggered_bearish_pattern_id: bearishPatternId,
      triggered_bullish_pattern_id: bullishPatternId,
      computed_at: new Date().toISOString(),
    }, { conflict: ["run_id", "instrument_id"] });
  if (error) throw error;
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

async function logStage(db, runId, stage, status, message) {
  await ops.insert(db, "pipeline_audit_log", { run_id: runId, stage, status, message });
}

async function recordCriticalPersistenceError(db, runId, instrumentId, stage, err) {
  const message = err instanceof Error ? err.message : String(err);
  const { error } = await ops.insert(db, "pipeline_persistence_errors", {
    run_id: runId,
    instrument_id: instrumentId,
    stage,
    message,
  });
  if (error) throw error;
}

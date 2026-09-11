// The single source of truth for whether a screening_runs row should be
// 'running', 'completed', or 'partial'. Pure function, no DB access -- the
// caller (index.ts's processReconcileBatch) gathers the inputs and just
// writes back whatever this returns.
//
// This is the fix for the core dishonesty bug: a run must never become
// 'completed' while real work (universe/incremental/reconcile batches) is
// still pending or in_progress, and never while fewer real results exist
// than the expected universe size -- even if every result that DOES exist
// looks internally consistent (that's all reconcile.js's reconcileCoverage
// checks; it has no notion of the expected universe size at all, so it can
// never catch "we only tried 14 of 501" on its own).
//
// 'backfill' batches are deliberately NOT "blocking" -- they're a one-time
// historical-depth enrichment (see fyers.js/index.ts), not part of the
// per-run coverage contract, so a run can legitimately reach 'completed'
// with backfill work still pending for some instruments.
//
// 'reconcile' is also deliberately excluded from BLOCKING_STAGES, even
// though it's on the completion-critical path: this function is only ever
// called from *inside* the reconcile batch's own processing (or from the
// give-up path once reconcile has been force-failed), at which point the
// reconcile batch's own row is unavoidably still 'in_progress' (the caller
// marks it 'done' only after this decision is made) -- treating it as
// "blocking" would make every run's first finalization attempt look like
// blocking work remains, permanently misreporting 'running'.

const BLOCKING_STAGES = new Set(["universe", "incremental"]);

/**
 * @param {object} params
 * @param {{stage: string, status: string}[]} params.batches - this run's pipeline_batches rows
 * @param {number} params.universeCount - expected non-index instrument count (union of all incremental chunk cursors)
 * @param {number} params.resultCount - actual instrument_run_results rows for this run (non-index)
 * @param {number} params.elapsedMs - wall-clock time since the run started
 * @param {number} params.maxDurationMs - the run's total time budget before giving up on pending work
 * @returns {"running"|"completed"|"partial"}
 */
export function decideRunStatus({ batches, universeCount, resultCount, elapsedMs, maxDurationMs }) {
  const hasPendingBlockingWork = batches.some(
    (b) => BLOCKING_STAGES.has(b.stage) && (b.status === "pending" || b.status === "in_progress")
  );

  if (hasPendingBlockingWork) {
    // Still real work to do. Only conclude early if we've decided to give up
    // on the overall duration cap -- otherwise a future invocation (self-chain
    // or the recovery-sweep cron) will pick this up.
    return elapsedMs > maxDurationMs ? "partial" : "running";
  }

  const hasFailedBlockingBatch = batches.some((b) => BLOCKING_STAGES.has(b.stage) && b.status === "failed");
  const fullyCovered = resultCount >= universeCount;
  return fullyCovered && !hasFailedBlockingBatch ? "completed" : "partial";
}

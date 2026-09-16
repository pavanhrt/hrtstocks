// Durable, resumable ingestion design for ONE fundamental refresh cycle
// against the Upstox Fundamentals API -- a plan and a set of pure helper
// functions, not a deployed Edge Function (none is deployed this pass; no
// credential is used by this session -- see CONTINUATION.md). A future
// `ingest-fundamental-data` Edge Function implements this plan the same
// way analyze-buy-setup implements three-timeframe-gate.js's plan.
//
// REVISED 2026-09-16 -- corrected rate-limit math (the original version of
// this file claimed "3,507 requests fit in ~8 minutes," which only checked
// the per-minute cap and ignored Upstox's own tighter 2,000-per-rolling-
// 30-minute cap entirely -- mathematically wrong, corrected below) plus
// three further corrections: dropped corporate-actions (unused by score
// v1), added checksum-based response caching, and added an explicit
// auth-failure-pauses-the-manifest design (a token expiring mid-refresh
// must never be blindly retried).
//
//   1. DURABLE MANIFEST + PER-INSTRUMENT/ENDPOINT PROGRESS: reuses this
//      migration's own fundamental_refresh_manifests row for the batch as a
//      whole; per-instrument/endpoint progress is tracked the same way
//      run-screening tracks pipeline_batches -- one row per (instrument
//      chunk, endpoint) pending/in_progress/done/failed, claimed via the
//      SAME claim/reset pattern already proven twice in this repo
//      (claim_next_buy_setup_batch/reset_stale_buy_setup_batches, migration
//      0011) -- a `claim_next_fundamental_ingestion_batch` /
//      `reset_stale_fundamental_ingestion_batches` pair, written at the
//      same time as the Edge Function itself (not built this pass, since
//      there is nothing yet to ingest).
//   2. BOUNDED BATCHES: buildIngestionBatches() below (reusing
//      run-screening/pipeline/chunks.js's buildChunks, unmodified) splits
//      the 501-instrument universe into fixed-size chunks; each chunk x
//      each endpoint is one durable batch row, mirroring 0011's own
//      buy_setup_pipeline_batches shape exactly.
//   3. RATE LIMITING -- IMPLEMENTED, not merely documented: rate-limiter.js
//      persistently reserves a slot against ALL THREE of Upstox's
//      documented tiers (50/sec, 500/min, 2,000/rolling-30-min, verified
//      live 2026-09-16) via a real, atomic, continuously-refilling TOKEN
//      BUCKET per tier (`try_acquire_token_bucket_slot`, migration 0015)
//      before every single request -- a request is only ever made after all
//      three reservations succeed. REVISED 2026-09-16 (item 8): the earlier
//      version of this design used a FIXED window (aligned to :00/:30 past
//      the hour, via migration 0007's minute_bucket primitive) for the
//      30-minute tier, which is NOT equivalent to a true rolling window and
//      can permit up to double the documented limit across a boundary (see
//      rate-limiter.js's own header for the exact failure mode and its
//      fix). A token bucket has no boundary to burst across -- it gives a
//      mathematically guaranteed cap on requests in ANY rolling window of
//      the matching duration. See "corrected minimum duration" below for
//      why the 30-minute tier, not the per-minute tier, is the true binding
//      constraint (unchanged by this fix -- only the enforcement mechanism
//      changed, not the underlying math).
//   4. RETRIES WITH BACKOFF FOR TRANSIENT FAILURES, NO BLIND RETRY FOR
//      AUTH/VALIDATION ERRORS: upstox-client.js's UpstoxApiError.retryable
//      flag (true for 429/5xx, false for 401/403/4xx) is the exact signal
//      the batch-claim loop uses to decide "requeue as pending" (transient,
//      same MAX_CHUNK_ATTEMPTS-bounded retry as buy_setup_pipeline_batches)
//      vs. "stop and surface for a human" (see point 10 below -- an
//      expired/invalid UPSTOX_ACCESS_TOKEN is never retried into the same
//      wall).
//   5. LEASE PROTECTION + RESUMABILITY: a screening_run_leases row for a
//      new run_type='fundamental_ingestion' (seeded the same way migration
//      0012 had to retroactively seed 'buy_setup_analysis' -- this plan
//      deliberately seeds it in the SAME migration that introduces the
//      Edge Function, learning directly from that earlier bug), acquired
//      via the existing generic acquireRunLease/heartbeatRunLease/
//      releaseRunLease (run-lease.js, already provider-agnostic). A
//      time-budget check + self-chain HTTP POST handoff (identical
//      structure to analyze-buy-setup's own runEnrichment loop) makes an
//      interrupted refresh resumable from exactly where it left off.
//   6. RAW-RESPONSE CHECKSUMS AND CACHING: every fundamental_source_snapshots
//      row's `checksum` column is a SHA-256 of the raw Upstox response body
//      (computeChecksum below). Before writing a freshly-fetched response,
//      the ingestion job compares its checksum against the most recent
//      stored snapshot for the same (instrument, period, source,
//      consolidation) -- see shouldSkipUnchangedResponse() below. An
//      unchanged checksum means the write (and any downstream
//      reprocessing) is skipped entirely -- this does not reduce the FETCH
//      itself (Upstox has no ETag/If-Modified-Since documented), but it
//      does eliminate redundant writes/reprocessing for endpoints that
//      rarely change between refreshes (profile, key-ratios).
//   7. REDUCED REQUEST VOLUME: corporate-actions is DROPPED from v1's
//      endpoint list -- not used by any scoring component (dividends/
//      splits/bonus issues feed no sub-metric in fundamental-score.yaml
//      v1.0.0). ROE/ROCE/ROA are NOT separately fetched from key-ratios for
//      the non-financial model -- they are already derivable from
//      balance-sheet + income-statement figures already being fetched
//      (net_profit/total_equity/total_asset), so key-ratios is fetched only
//      for the bank/NBFC model (which needs ROA/NIM that aren't otherwise
//      derivable) -- see FUNDAMENTAL_ENDPOINTS_BY_SECTOR below.
//   8. CADENCE: not every endpoint needs fetching every refresh. Balance
//      sheet/income statement/cash flow/share-holdings change at most
//      quarterly; profile changes rarely (sector reclassification is
//      exceptional). A production refresh should fetch quarterly-cadence
//      endpoints roughly weekly (catches a new quarterly result within a
//      week of release, not same-day) and profile only monthly --
//      CADENCE_DAYS below documents this; not enforced by these pure
//      helpers themselves (that's the not-yet-built Edge Function's job to
//      check "was this endpoint fetched for this instrument within its own
//      cadence window" before even attempting a fetch).
//   9. COVERAGE RECONCILIATION: fundamental_refresh_manifests' own
//      expected_instrument_count/scored_count/no_data_count/
//      manual_review_count columns (already in migration 0014) play the
//      same reconciliation role buy_setup_manifests' equivalents do,
//      checked by a future publish_fundamental_refresh() RPC mirroring
//      publish_buy_setup_enrichment()'s own validate-before-publish shape.
//  10. TOKEN EXPIRY MID-REFRESH: migration 0014's fundamental_refresh_manifests
//      now includes 'auth_required' as a distinct refresh_state (alongside
//      pending/processing/validated/validation_failed/published) -- the
//      first UpstoxApiError with retryable=false AND status in (401,403)
//      transitions the manifest to 'auth_required' immediately (not
//      'validation_failed', which implies the DATA was bad, not the
//      CREDENTIAL) and the batch loop stops claiming further work for this
//      manifest. This is a distinct, actionable status a human can act on
//      (refresh UPSTOX_ACCESS_TOKEN) rather than a generic failure that
//      looks retryable.
//  11. NO COUPLING TO THE TECHNICAL SCREENING LOOP: this ingestion has its
//      own lease, its own manifest, its own cutoff -- run-screening and
//      analyze-buy-setup never call it, wait for it, or read any
//      fundamental_* table. bind_fundamental_scores_for_refresh() /
//      bind_fundamental_scores_for_run() (0014) are the ONLY connections to
//      a screening_run, and both are called FROM the fundamental/screening
//      publish steps respectively, never the reverse.
//  12. NO FUNDAMENTAL REQUESTS DURING PAGE RENDERING: app/src/lib/data/
//      fundamental-score.ts and buy-setup-analysis.ts only ever SELECT
//      already-computed, already-published rows -- neither file imports
//      upstox-client.js or anything under providers/, and neither one can,
//      since a Next.js server component has no business holding a
//      long-lived provider access token at all.
//
// CORRECTED MINIMUM DURATION for a full 501-stock refresh (v1 endpoint set,
// 6 endpoints after dropping corporate-actions, non-financial model skips
// key-ratios -- see point 7): 501 x 5 (non-financial's profile/
// balance-sheet/income-statement/cash-flow/share-holdings) plus however
// many bank/NBFC instruments also need key-ratios ~= roughly 2,600-3,000
// requests for a full initial backfill, depending on the real bank/NBFC
// share of the universe. The 2,000-per-rolling-30-minute cap -- NOT the
// 500/minute cap -- is the binding constraint (2,000 < 500 x 30 = 15,000):
// a full backfill needs AT LEAST two 30-minute windows, i.e. a truthful
// minimum of ~30 minutes wall-clock, realistically 30-60 minutes depending
// on exactly when within a window the run starts (a burst that lands late
// in one window must wait out the remainder of it before the next 2,000-
// request budget opens). This is a ONE-TIME backfill cost -- with cadence
// (point 8) respected, a STEADY-STATE daily refresh only re-fetches
// instruments whose cadence window has elapsed, which in practice is a
// small fraction of the universe on most days (a spike only around
// quarterly-results season), not a full 2,600-3,000-request run every day.

import { buildChunks } from "../../run-screening/pipeline/chunks.js";

// corporate-actions and competitors dropped from v1 -- unused by any
// fundamental-score.yaml v1.0.0 component (see point 7 above).
export const FUNDAMENTAL_ENDPOINTS_NON_FINANCIAL = Object.freeze(["profile", "balance-sheet", "income-statement", "cash-flow", "share-holdings"]);
export const FUNDAMENTAL_ENDPOINTS_BANK_NBFC = Object.freeze(["profile", "balance-sheet", "income-statement", "cash-flow", "share-holdings", "key-ratios"]);

// Refresh cadence in days -- how often each endpoint's data is worth
// re-fetching, given how often the underlying figures actually change.
// Enforced by the (not yet built) Edge Function, not by these pure helpers.
export const ENDPOINT_CADENCE_DAYS = Object.freeze({
  profile: 30,
  "balance-sheet": 7,
  "income-statement": 7,
  "cash-flow": 7,
  "share-holdings": 7,
  "key-ratios": 7,
});

// 10 instruments per batch keeps each batch's own request count small and
// bounded regardless of which endpoint-set it belongs to.
export const FUNDAMENTAL_INSTRUMENT_CHUNK_SIZE = 10;

/**
 * @param {string[]} instrumentIds -- the full stock universe for this refresh.
 * @param {string[]} [endpoints] -- defaults to the non-financial endpoint set; pass FUNDAMENTAL_ENDPOINTS_BANK_NBFC for bank/NBFC instruments.
 * @returns {{stage: string, instrumentIds: string[]}[]} one durable batch
 *   per (instrument chunk, endpoint) pair -- the exact row shape a future
 *   fundamental_ingestion_batches table would store (cursor = JSON of
 *   instrumentIds, stage = the endpoint name), mirroring
 *   buy_setup_pipeline_batches (0011) exactly.
 */
export function buildIngestionBatches(instrumentIds, endpoints = FUNDAMENTAL_ENDPOINTS_NON_FINANCIAL) {
  const instrumentChunks = buildChunks(instrumentIds, FUNDAMENTAL_INSTRUMENT_CHUNK_SIZE);
  const batches = [];
  for (const endpoint of endpoints) {
    for (const chunk of instrumentChunks) {
      batches.push({ stage: endpoint, instrumentIds: chunk });
    }
  }
  return batches;
}

/** SHA-256 hex digest of a raw provider response body, for fundamental_source_snapshots.checksum. */
export async function computeChecksum(rawResponseText) {
  const encoded = new TextEncoder().encode(rawResponseText);
  const digest = await crypto.subtle.digest("SHA-256", encoded);
  return "sha256:" + Array.from(new Uint8Array(digest)).map((b) => b.toString(16).padStart(2, "0")).join("");
}

/**
 * @param {string|null} latestStoredChecksum -- the most recent stored
 *   snapshot's checksum for this (instrument, period, source, consolidation), or null if none exists yet.
 * @param {string} freshChecksum -- the checksum of a just-fetched response.
 * @returns {boolean} true when the write (and reprocessing) should be
 *   skipped because the response is byte-identical to what is already
 *   stored -- never skips when nothing is stored yet (null always means
 *   "not a cache hit, must write").
 */
export function shouldSkipUnchangedResponse(latestStoredChecksum, freshChecksum) {
  return latestStoredChecksum != null && latestStoredChecksum === freshChecksum;
}

/**
 * @param {string} endpoint
 * @param {string|null} lastFetchedAtIso -- when this endpoint was last successfully fetched for this instrument, or null if never.
 * @param {string} [nowIso]
 * @returns {boolean} true when this endpoint is due for a fresh fetch under its own cadence.
 */
export function isDueForRefresh(endpoint, lastFetchedAtIso, nowIso = new Date().toISOString()) {
  if (!lastFetchedAtIso) return true;
  const cadenceDays = ENDPOINT_CADENCE_DAYS[endpoint];
  if (cadenceDays == null) return true; // unknown endpoint -- fetch rather than silently skip
  const elapsedMs = Date.parse(nowIso) - Date.parse(lastFetchedAtIso);
  return elapsedMs >= cadenceDays * 24 * 60 * 60 * 1000;
}

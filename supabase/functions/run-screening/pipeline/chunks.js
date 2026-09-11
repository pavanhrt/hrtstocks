// Splits a (typically already-shuffled, see shuffle.js) list of instruments
// into fixed-size chunks, each of which becomes one pipeline_batches row
// (migration 0008). Pure, no DB/Deno dependency.

// PROJECT_DEFAULT: justified by providers/fyers.js's SHARED_RATE_LIMIT_PER_MINUTE
// (180 req/min) -- 60 requests take a minimum ~20s no matter how much
// per-chunk concurrency is used, leaving comfortable margin under the
// platform's ~150s wall-clock kill even accounting for DB-write overhead and
// an occasional 429 backoff.
export const CHUNK_SIZE = 60;

// A backfill instrument can need up to 5 sequential Fyers requests (one per
// ~366-day leg, walking back up to 5 years -- see fyers.js's fetchOHLCVRange).
// 12 instruments * 5 requests = 60, the same request-count envelope as one
// CHUNK_SIZE incremental chunk.
export const BACKFILL_CHUNK_SIZE = 12;

/**
 * @param {string[]} items
 * @param {number} chunkSize
 * @returns {string[][]} chunkSize-sized chunks, in the same relative order as `items`; the last chunk may be smaller.
 */
export function buildChunks(items, chunkSize) {
  if (chunkSize <= 0) throw new Error(`buildChunks: chunkSize must be positive, got ${chunkSize}`);
  const chunks = [];
  for (let i = 0; i < items.length; i += chunkSize) {
    chunks.push(items.slice(i, i + chunkSize));
  }
  return chunks;
}

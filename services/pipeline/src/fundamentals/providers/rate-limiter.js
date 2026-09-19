// Persistent, cross-invocation rate-limit reservation for the Upstox
// Fundamentals API.
//
// REVISED 2026-09-16 (item 8, correction pass 3) -- the original version of
// this module modeled all three of Upstox's documented tiers (50/sec,
// 500/min, 2,000/rolling-30-min) as FIXED windows (a 30-minute tier aligned
// to :00/:30 past the hour, via migration 0007's existing minute_bucket
// primitive). That is NOT equivalent to a rolling window and is NOT
// conservative at a boundary: a caller could exhaust 2,000 slots in the last
// second of window [10:00,10:30) and another 2,000 in the first second of
// [10:30,11:00) -- 4,000 requests in about two real seconds, double the
// documented limit. (This module's own earlier comment claimed the fixed
// window was "always at least as conservative as a true rolling window,
// never less" -- that claim was wrong and is retracted.)
//
// Fixed with a real, atomic, persistent TOKEN BUCKET per tier (migration
// 0015's `try_acquire_token_bucket_slot`, new table, NOT reusing migration
// 0007's fixed-window primitive, which remains unmodified for Fyers' own
// pacing). A token bucket started full with capacity C and refilled
// continuously at C / windowSeconds tokens/second has a mathematically
// guaranteed property a fixed window does not: it can never allow more than
// C requests in ANY rolling window of windowSeconds seconds -- there is no
// boundary to burst across.
//
// Upstox's own documented rate limits (https://upstox.com/developer/api-documentation/rate-limiting,
// verified live 2026-09-16): the Fundamentals endpoints are not separately
// listed and fall under "Other Standard APIs" -- 50 requests/second,
// 500/minute, 2,000 per rolling 30 minutes, enforced per-user.
//
// A request may proceed ONLY when all three reservations succeed, checked in
// tightest-to-loosest order so a request that would fail a looser tier never
// wastes a token in the process (each acquireSlot call actually consumes a
// token on success -- an unnecessary consumption on a tier the request will
// fail anyway would itself be a small leak).

export const UPSTOX_RATE_LIMITS = Object.freeze({
  perSecond: 50,
  perMinute: 500,
  per30Minutes: 2000,
});

const WINDOW_SECONDS = Object.freeze({
  perSecond: 1,
  perMinute: 60,
  per30Minutes: 1800,
});

const REASON_BY_TIER = Object.freeze({
  perSecond: "per_second_limit",
  perMinute: "per_minute_limit",
  per30Minutes: "per_30_minute_limit",
});

const TIER_ORDER = ["perSecond", "perMinute", "per30Minutes"];

/** Tokens/second a tier's bucket must refill at so capacity is never exceeded in any rolling window of that tier's own duration. */
export function refillPerSecond(tier) {
  return UPSTOX_RATE_LIMITS[tier] / WINDOW_SECONDS[tier];
}

/**
 * @param {(bucketKey: string, capacity: number, refillPerSecond: number, nowMs: number) => Promise<boolean>} acquireSlot
 *   -- mirrors try_acquire_token_bucket_slot's own contract: returns true
 *   when a token was available and consumed, false when the bucket is
 *   currently empty. Callers pass a function that invokes the database function;
 *   tests pass an in-memory fake so this module needs no live database.
 * @param {number} [now] -- epoch ms, injectable for deterministic tests.
 */
export async function reserveUpstoxRequestSlot(acquireSlot, now = Date.now()) {
  for (const tier of TIER_ORDER) {
    const acquired = await acquireSlot(`upstox-${tier}`, UPSTOX_RATE_LIMITS[tier], refillPerSecond(tier), now);
    if (!acquired) return { acquired: false, reason: REASON_BY_TIER[tier] };
  }
  return { acquired: true };
}

/**
 * A conservative backoff for a caller that just failed the given tier: the
 * time (ms) for exactly one more token to regenerate on that tier's bucket.
 * Unlike the old fixed-window design's "wait until the next :00/:30
 * boundary" (which could mean waiting up to a full window even though a
 * slot might already exist a moment later), a token bucket's own backoff is
 * always this short -- there is no boundary to wait for.
 */
export function msToWaitForNextToken(tier) {
  return Math.ceil(1000 / refillPerSecond(tier));
}

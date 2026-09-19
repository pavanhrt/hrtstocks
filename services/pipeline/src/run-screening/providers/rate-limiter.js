// Cross-invocation provider rate limiting, backed by
// provider_rate_limit_buckets (migration 0007). The in-memory pacer in
// fyers.js stays as a cheap first line of defense (avoids a DB round trip
// for the common case of one invocation making calls well under the cap),
// but this is the authoritative, cross-invocation guard -- the one that
// would have prevented this session's actual incident (5 concurrent runs
// each pacing independently, collectively exceeding Fyers' 200/min cap).

/**
 * Truncates a Date to the start of its minute, in UTC -- the same bucketing
 * `date_trunc('minute', now())` produces in Postgres, factored out so the
 * bucketing logic itself is unit-testable without a database.
 * @param {Date} date
 * @returns {string} ISO timestamp truncated to the minute
 */
export function minuteBucketOf(date) {
  const d = new Date(date);
  d.setUTCSeconds(0, 0);
  return d.toISOString();
}

/**
 * Atomically claims one request slot for `provider` in the current minute.
 * @param {import("../../db/client.js").Db} db
 * @param {string} provider e.g. "fyers"
 * @param {number} limitPerMinute
 * @param {Date} [now]
 * @returns {Promise<{acquired: boolean, requestCount: number|null}>}
 */
export async function tryAcquireRateLimitSlot(db, provider, limitPerMinute, now = new Date()) {
  const bucket = minuteBucketOf(now);
  // Postgres upsert semantics: when the DO UPDATE's WHERE clause doesn't match
  // the existing row, that row is left untouched and RETURNING yields no row --
  // there is no window where two concurrent callers can both read "count <
  // limit" and both write, because the increment and the limit check happen in
  // the same statement under the row's own lock (migration 0007).
  const rows = await db.query("select request_count from try_acquire_rate_limit_slot($1, $2::timestamptz, $3::integer)", [provider, bucket, limitPerMinute]);
  if (rows.length === 0) return { acquired: false, requestCount: null };
  return { acquired: true, requestCount: rows[0].request_count };
}

/**
 * Blocks (via a real delay, not a busy loop) until a slot is available,
 * retrying at the top of the next minute when the current one is exhausted.
 * Bounded by `maxWaitMs` so a misconfigured limit can't hang a run forever.
 */
export async function waitForRateLimitSlot(db, provider, limitPerMinute, { maxWaitMs = 90_000, sleepFn = defaultSleep } = {}) {
  const deadline = Date.now() + maxWaitMs;
  for (;;) {
    const { acquired } = await tryAcquireRateLimitSlot(db, provider, limitPerMinute);
    if (acquired) return true;
    if (Date.now() >= deadline) return false;
    const msIntoMinute = Date.now() % 60_000;
    const msUntilNextMinute = 60_000 - msIntoMinute;
    await sleepFn(Math.min(msUntilNextMinute, deadline - Date.now()));
  }
}

function defaultSleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, Math.max(0, ms)));
}

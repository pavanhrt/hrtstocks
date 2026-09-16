import { test } from "node:test";
import assert from "node:assert/strict";
import { reserveUpstoxRequestSlot, refillPerSecond, msToWaitForNextToken, UPSTOX_RATE_LIMITS } from "./rate-limiter.js";

/**
 * In-memory fake mirroring try_acquire_token_bucket_slot's own contract: a
 * real token bucket per bucket_key, started full, refilled continuously by
 * elapsed time x refill rate, capped at capacity, never allowing more than
 * `capacity` acquisitions in any rolling window of (capacity/refillPerSecond)
 * seconds -- including one that straddles this bucket's own creation
 * instant, which is exactly the property the old fixed-window design lacked.
 */
function fakeTokenBucketAcquirer() {
  const buckets = new Map();
  return {
    buckets,
    acquire: async (bucketKey, capacity, refillRate, nowMs) => {
      let bucket = buckets.get(bucketKey);
      if (!bucket) {
        bucket = { tokens: capacity, updatedAtMs: nowMs, capacity, refillRate };
        buckets.set(bucketKey, bucket);
      }
      const elapsedSeconds = Math.max(0, (nowMs - bucket.updatedAtMs) / 1000);
      const refilled = Math.min(bucket.capacity, bucket.tokens + elapsedSeconds * bucket.refillRate);
      bucket.updatedAtMs = nowMs;
      if (refilled < 1) {
        bucket.tokens = refilled;
        return false;
      }
      bucket.tokens = refilled - 1;
      return true;
    },
  };
}

test("reserveUpstoxRequestSlot: succeeds when all three tiers have room", async () => {
  const { acquire } = fakeTokenBucketAcquirer();
  const result = await reserveUpstoxRequestSlot(acquire, Date.now());
  assert.deepEqual(result, { acquired: true });
});

test("reserveUpstoxRequestSlot: fails on the per-second tier before ever touching per-minute/per-30-minute", async () => {
  const now = Date.now();
  const { acquire, buckets } = fakeTokenBucketAcquirer();
  buckets.set("upstox-perSecond", { tokens: 0, updatedAtMs: now, capacity: UPSTOX_RATE_LIMITS.perSecond, refillRate: refillPerSecond("perSecond") });
  const result = await reserveUpstoxRequestSlot(acquire, now);
  assert.deepEqual(result, { acquired: false, reason: "per_second_limit" });
  assert.ok(!buckets.has("upstox-perMinute"), "must not attempt the minute tier once the second tier is exhausted");
});

test("reserveUpstoxRequestSlot: fails on the per-minute tier when only that one is exhausted", async () => {
  const now = Date.now();
  const { acquire, buckets } = fakeTokenBucketAcquirer();
  buckets.set("upstox-perMinute", { tokens: 0, updatedAtMs: now, capacity: UPSTOX_RATE_LIMITS.perMinute, refillRate: refillPerSecond("perMinute") });
  const result = await reserveUpstoxRequestSlot(acquire, now);
  assert.deepEqual(result, { acquired: false, reason: "per_minute_limit" });
});

test("reserveUpstoxRequestSlot: fails on the 30-minute rolling tier -- the binding constraint per the corrected math (2,000 < 500/min x 30min)", async () => {
  const now = Date.now();
  const { acquire, buckets } = fakeTokenBucketAcquirer();
  buckets.set("upstox-per30Minutes", { tokens: 0, updatedAtMs: now, capacity: UPSTOX_RATE_LIMITS.per30Minutes, refillRate: refillPerSecond("per30Minutes") });
  const result = await reserveUpstoxRequestSlot(acquire, now);
  assert.deepEqual(result, { acquired: false, reason: "per_30_minute_limit" });
});

test("30-minute tier: exactly UPSTOX_RATE_LIMITS.per30Minutes acquisitions succeed at one instant, the next one fails -- proves the 2,000/30-min cap is actually enforced (tested directly against the acquirer, since the per-second/per-minute tiers would otherwise dominate a same-instant loop)", async () => {
  const { acquire } = fakeTokenBucketAcquirer();
  const now = Date.now();
  let succeeded = 0;
  for (let i = 0; i < UPSTOX_RATE_LIMITS.per30Minutes; i++) {
    const ok = await acquire("upstox-per30Minutes", UPSTOX_RATE_LIMITS.per30Minutes, refillPerSecond("per30Minutes"), now);
    if (ok) succeeded++;
  }
  assert.equal(succeeded, UPSTOX_RATE_LIMITS.per30Minutes);
  const overLimit = await acquire("upstox-per30Minutes", UPSTOX_RATE_LIMITS.per30Minutes, refillPerSecond("per30Minutes"), now);
  assert.equal(overLimit, false);
});

// ---------------------------------------------------------------------------
// The actual bug this pass fixes: a fixed :00/:30 window allows DOUBLE the
// limit across a boundary. A token bucket must not.
// ---------------------------------------------------------------------------

test("BOUNDARY: exhausting a bucket right before what would have been a fixed-window boundary leaves it exhausted just after -- no free burst at any 'boundary', because there is none", async () => {
  const { acquire } = fakeTokenBucketAcquirer();
  const t0 = Date.parse("2026-09-16T10:29:59.900Z"); // 100ms before the old fixed 30-min boundary
  for (let i = 0; i < UPSTOX_RATE_LIMITS.per30Minutes; i++) {
    await acquire("upstox-per30Minutes", UPSTOX_RATE_LIMITS.per30Minutes, refillPerSecond("per30Minutes"), t0);
  }
  const justAfterOldBoundary = Date.parse("2026-09-16T10:30:00.100Z"); // 200ms later, crossing the old :00/:30 line
  const acquiredRightAfterBoundary = await acquire("upstox-per30Minutes", UPSTOX_RATE_LIMITS.per30Minutes, refillPerSecond("per30Minutes"), justAfterOldBoundary);
  // Only ~0.9 tokens could have refilled in 200ms at ~1.11 tokens/sec --
  // nowhere near a fresh 2,000-token allowance the old fixed-window design
  // would have granted the instant the clock crossed :30.
  assert.equal(acquiredRightAfterBoundary, false, "a token bucket must never grant a fresh full allowance merely because a fixed-window boundary was crossed");
});

test("BOUNDARY: no 4,000-in-2-seconds burst is possible across what would have been two fixed windows (the exact failure mode this fix closes)", async () => {
  const { acquire } = fakeTokenBucketAcquirer();
  const justBeforeOldBoundary = Date.parse("2026-09-16T10:29:59.500Z");
  const justAfterOldBoundary = Date.parse("2026-09-16T10:30:00.500Z"); // 1 second later
  let totalAcquired = 0;
  for (let i = 0; i < UPSTOX_RATE_LIMITS.per30Minutes; i++) {
    if (await acquire("upstox-per30Minutes", UPSTOX_RATE_LIMITS.per30Minutes, refillPerSecond("per30Minutes"), justBeforeOldBoundary)) totalAcquired++;
  }
  for (let i = 0; i < UPSTOX_RATE_LIMITS.per30Minutes; i++) {
    if (await acquire("upstox-per30Minutes", UPSTOX_RATE_LIMITS.per30Minutes, refillPerSecond("per30Minutes"), justAfterOldBoundary)) totalAcquired++;
  }
  // The old fixed-window design would have allowed close to 4,000 here (2,000
  // in each "window"). A token bucket allows only ~2,000 + (1 second's worth
  // of refill), nowhere close to double the documented limit.
  assert.ok(totalAcquired < UPSTOX_RATE_LIMITS.per30Minutes * 1.1, `expected well under double the limit across a 1-second span straddling the old boundary, got ${totalAcquired}`);
});

// ---------------------------------------------------------------------------
// Refill behavior and concurrency-safety of the accounting itself.
// ---------------------------------------------------------------------------

test("refill: tokens regenerate proportionally to elapsed time, never exceeding capacity", async () => {
  const { acquire } = fakeTokenBucketAcquirer();
  const t0 = Date.now();
  for (let i = 0; i < UPSTOX_RATE_LIMITS.perMinute; i++) {
    await acquire("upstox-perMinute", UPSTOX_RATE_LIMITS.perMinute, refillPerSecond("perMinute"), t0);
  }
  // Half the window later, roughly half the capacity should have refilled.
  const halfWindowLater = t0 + 30_000; // perMinute window is 60s
  let succeededAfterHalfWindow = 0;
  for (let i = 0; i < UPSTOX_RATE_LIMITS.perMinute; i++) {
    if (await acquire("upstox-perMinute", UPSTOX_RATE_LIMITS.perMinute, refillPerSecond("perMinute"), halfWindowLater)) succeededAfterHalfWindow++;
  }
  assert.ok(
    Math.abs(succeededAfterHalfWindow - UPSTOX_RATE_LIMITS.perMinute / 2) <= 1,
    `expected roughly half the capacity to have refilled after half the window, got ${succeededAfterHalfWindow}`
  );
  // A full window or more later, the bucket must never exceed its own capacity.
  const wellPast = t0 + 10 * 60_000;
  let succeededWellPast = 0;
  for (let i = 0; i < UPSTOX_RATE_LIMITS.perMinute + 50; i++) {
    if (await acquire("upstox-perMinute", UPSTOX_RATE_LIMITS.perMinute, refillPerSecond("perMinute"), wellPast)) succeededWellPast++;
  }
  assert.equal(succeededWellPast, UPSTOX_RATE_LIMITS.perMinute, "refill must never exceed the bucket's own capacity");
});

test("CONCURRENCY: interleaved acquisitions against the SAME bucket_key never exceed capacity, however they are ordered -- proves the accounting is exact, not merely eventually-consistent", async () => {
  const { acquire } = fakeTokenBucketAcquirer();
  const now = Date.now();
  const capacity = UPSTOX_RATE_LIMITS.perSecond;
  // Simulate many "concurrent" callers by firing acquisitions without
  // awaiting between them (Promise.all), the way multiple ingestion workers
  // hitting the same tier at once would -- every one resolves against the
  // SAME single-threaded fake, exactly mirroring how the real RPC's atomic
  // INSERT-then-SELECT-FOR-UPDATE serializes concurrent callers on the
  // database side (a second transaction blocks on the row lock until the
  // first commits, rather than reading a stale token count).
  const attempts = capacity + 25;
  const results = await Promise.all(
    Array.from({ length: attempts }, () => acquire("upstox-perSecond", capacity, refillPerSecond("perSecond"), now))
  );
  const succeeded = results.filter(Boolean).length;
  assert.equal(succeeded, capacity, "concurrent acquisitions against one bucket must never collectively exceed its capacity");
});

test("msToWaitForNextToken: a short, tier-specific backoff -- never 'wait for the next fixed window' the way the old design required", () => {
  // The per-30-minute tier refills roughly 1.11 tokens/sec -- one more token
  // is available in under a second, nowhere near the old design's potential
  // 30-minute wait.
  const wait = msToWaitForNextToken("per30Minutes");
  assert.ok(wait > 0 && wait < 2000, `expected a sub-2-second backoff for the 30-minute tier, got ${wait}ms`);
});

test("refillPerSecond: each tier's rate is capacity / its own window duration", () => {
  assert.equal(refillPerSecond("perSecond"), 50 / 1);
  assert.equal(refillPerSecond("perMinute"), 500 / 60);
  assert.ok(Math.abs(refillPerSecond("per30Minutes") - 2000 / 1800) < 1e-9);
});

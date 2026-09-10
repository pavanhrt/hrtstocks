import { test } from "node:test";
import assert from "node:assert/strict";
import { minuteBucketOf, tryAcquireRateLimitSlot, waitForRateLimitSlot } from "./rate-limiter.js";

test("minuteBucketOf truncates to the start of the UTC minute", () => {
  assert.equal(minuteBucketOf(new Date("2026-09-10T06:37:42.123Z")), "2026-09-10T06:37:00.000Z");
  assert.equal(minuteBucketOf(new Date("2026-09-10T06:37:00.000Z")), "2026-09-10T06:37:00.000Z");
});

/** A fake Supabase client exposing just the .rpc() shape tryAcquireRateLimitSlot depends on. */
function fakeSupabase(responses) {
  let call = 0;
  return {
    calls: [],
    rpc(name, args) {
      this.calls.push({ name, args });
      const response = responses[Math.min(call, responses.length - 1)];
      call++;
      return Promise.resolve(response);
    },
  };
}

test("tryAcquireRateLimitSlot reports acquired=true with the returned count when a row comes back", async () => {
  const supabase = fakeSupabase([{ data: [{ request_count: 5 }], error: null }]);
  const result = await tryAcquireRateLimitSlot(supabase, "fyers", 180);
  assert.deepEqual(result, { acquired: true, requestCount: 5, coordinated: true });
  assert.equal(supabase.calls[0].name, "try_acquire_rate_limit_slot");
  assert.equal(supabase.calls[0].args.p_provider, "fyers");
  assert.equal(supabase.calls[0].args.p_limit, 180);
});

test("tryAcquireRateLimitSlot reports acquired=false when the bucket is full (empty data)", async () => {
  const supabase = fakeSupabase([{ data: [], error: null }]);
  const result = await tryAcquireRateLimitSlot(supabase, "fyers", 180);
  assert.deepEqual(result, { acquired: false, requestCount: null, coordinated: true });
});

test("tryAcquireRateLimitSlot throws on a database error rather than silently treating it as a free slot", async () => {
  const supabase = fakeSupabase([{ data: null, error: new Error("connection reset") }]);
  await assert.rejects(() => tryAcquireRateLimitSlot(supabase, "fyers", 180));
});

test("tryAcquireRateLimitSlot degrades gracefully (acquired=true, coordinated=false) when migration 0007 isn't applied yet", async () => {
  const notFoundError = Object.assign(new Error("Could not find the function public.try_acquire_rate_limit_slot"), {
    code: "PGRST202",
  });
  const supabase = fakeSupabase([{ data: null, error: notFoundError }]);
  const result = await tryAcquireRateLimitSlot(supabase, "fyers", 180);
  assert.deepEqual(result, { acquired: true, requestCount: null, coordinated: false });
});

test("waitForRateLimitSlot returns true immediately when the first attempt acquires", async () => {
  const supabase = fakeSupabase([{ data: [{ request_count: 1 }], error: null }]);
  const ok = await waitForRateLimitSlot(supabase, "fyers", 180, { sleepFn: async () => {} });
  assert.equal(ok, true);
  assert.equal(supabase.calls.length, 1);
});

test("waitForRateLimitSlot retries after a failed attempt and succeeds on the second", async () => {
  const supabase = fakeSupabase([
    { data: [], error: null }, // bucket full
    { data: [{ request_count: 1 }], error: null }, // next minute, acquired
  ]);
  const sleeps = [];
  const ok = await waitForRateLimitSlot(supabase, "fyers", 180, {
    sleepFn: async (ms) => {
      sleeps.push(ms);
    },
  });
  assert.equal(ok, true);
  assert.equal(supabase.calls.length, 2);
  assert.equal(sleeps.length, 1);
});

test("waitForRateLimitSlot gives up and returns false once maxWaitMs is exceeded", async () => {
  const supabase = fakeSupabase([{ data: [], error: null }]); // always full
  let sleepCount = 0;
  const ok = await waitForRateLimitSlot(supabase, "fyers", 180, {
    maxWaitMs: 5,
    sleepFn: async () => {
      sleepCount++;
    },
  });
  assert.equal(ok, false);
  assert.ok(sleepCount >= 1);
});

import { after, before, test } from "node:test";
import assert from "node:assert/strict";
import pg from "pg";
import { migrate } from "../../../../../db/migrate.mjs";
import { startTestPostgres } from "../../../../../db/tests/pg-harness.mjs";
import { dbFromPool } from "../../db/client.js";
import { minuteBucketOf, tryAcquireRateLimitSlot, waitForRateLimitSlot } from "./rate-limiter.js";

test("minuteBucketOf truncates to the start of the UTC minute", () => {
  assert.equal(minuteBucketOf(new Date("2026-09-10T06:37:42.123Z")), "2026-09-10T06:37:00.000Z");
  assert.equal(minuteBucketOf(new Date("2026-09-10T06:37:00.000Z")), "2026-09-10T06:37:00.000Z");
});

/** A fake db exposing just the query() shape the limiter depends on; each call consumes the next scripted row set. */
function fakeDb(responses) {
  let call = 0;
  return {
    calls: [],
    async query(sql, params) {
      this.calls.push({ sql, params });
      const response = responses[Math.min(call, responses.length - 1)];
      call++;
      if (response instanceof Error) throw response;
      return response;
    },
  };
}

test("tryAcquireRateLimitSlot reports acquired=true with the returned count when a row comes back", async () => {
  const db = fakeDb([[{ request_count: 5 }]]);
  const result = await tryAcquireRateLimitSlot(db, "fyers", 180);
  assert.deepEqual(result, { acquired: true, requestCount: 5 });
  assert.match(db.calls[0].sql, /try_acquire_rate_limit_slot/);
  assert.equal(db.calls[0].params[0], "fyers");
  assert.equal(db.calls[0].params[2], 180);
});

test("tryAcquireRateLimitSlot reports acquired=false when the bucket is full (no rows)", async () => {
  const result = await tryAcquireRateLimitSlot(fakeDb([[]]), "fyers", 180);
  assert.deepEqual(result, { acquired: false, requestCount: null });
});

test("tryAcquireRateLimitSlot throws on a database error rather than silently treating it as a free slot", async () => {
  await assert.rejects(() => tryAcquireRateLimitSlot(fakeDb([new Error("connection reset")]), "fyers", 180), /connection reset/);
});

test("waitForRateLimitSlot returns true immediately when the first attempt acquires", async () => {
  const db = fakeDb([[{ request_count: 1 }]]);
  assert.equal(await waitForRateLimitSlot(db, "fyers", 180, { sleepFn: async () => {} }), true);
  assert.equal(db.calls.length, 1);
});

test("waitForRateLimitSlot retries after a failed attempt and succeeds on the second", async () => {
  const db = fakeDb([[], [{ request_count: 1 }]]);
  const sleeps = [];
  const ok = await waitForRateLimitSlot(db, "fyers", 180, { sleepFn: async (ms) => sleeps.push(ms) });
  assert.equal(ok, true);
  assert.equal(db.calls.length, 2);
  assert.equal(sleeps.length, 1);
  assert.ok(sleeps[0] > 0 && sleeps[0] <= 60_000);
});

test("waitForRateLimitSlot gives up and returns false once maxWaitMs is exceeded", async () => {
  const db = fakeDb([[]]); // always full
  assert.equal(await waitForRateLimitSlot(db, "fyers", 180, { maxWaitMs: 0, sleepFn: async () => {} }), false);
});

test("against real Postgres: exactly `limit` slots are granted per minute, even under concurrency", async () => {
  const pgx = await startTestPostgres();
  const pool = new pg.Pool({ connectionString: pgx.url, max: 10 });
  try {
    const c = await pgx.newClient();
    await migrate(c);
    await c.end();
    const db = dbFromPool(pool);
    const at = new Date("2026-09-10T06:37:10Z");
    const results = await Promise.all(Array.from({ length: 30 }, () => tryAcquireRateLimitSlot(db, "fyers", 10, at)));
    assert.equal(results.filter((r) => r.acquired).length, 10);
    // A different minute has a fresh allowance.
    assert.equal((await tryAcquireRateLimitSlot(db, "fyers", 10, new Date("2026-09-10T06:38:01Z"))).acquired, true);
  } finally {
    await pool.end();
    await pgx.stop();
  }
});

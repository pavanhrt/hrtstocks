import { test } from "node:test";
import assert from "node:assert/strict";
import { nextIncrementalRange, serializeFyersRequest } from "./fyers.js";

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

// fetchOHLCV/fetchOHLCVRange/fetchHourlyOHLCV are real network I/O (Fyers'
// live API) -- same convention as the rest of this codebase (no test doubles
// for outbound fetch), so only the pure date-range decision is unit-tested
// here.

test("nextIncrementalRange falls back to the full lookback window when no bar has ever been stored", () => {
  const range = nextIncrementalRange(null, "2026-09-10", 365);
  assert.equal(range.to.toISOString().slice(0, 10), "2026-09-10");
  assert.equal(range.from.toISOString().slice(0, 10), "2025-09-10");
});

test("nextIncrementalRange fetches only the day after the latest stored bar through the run date", () => {
  const range = nextIncrementalRange("2026-09-08", "2026-09-10", 365);
  assert.equal(range.from.toISOString().slice(0, 10), "2026-09-09");
  assert.equal(range.to.toISOString().slice(0, 10), "2026-09-10");
});

test("nextIncrementalRange returns null when the latest stored bar already covers the run date (retry/idempotent case)", () => {
  assert.equal(nextIncrementalRange("2026-09-10", "2026-09-10", 365), null);
});

test("nextIncrementalRange returns null when the latest stored bar is even newer than the run date", () => {
  assert.equal(nextIncrementalRange("2026-09-11", "2026-09-10", 365), null);
});

test("nextIncrementalRange handles a multi-day gap (e.g. a stock skipped for several runs)", () => {
  const range = nextIncrementalRange("2026-08-01", "2026-09-10", 365);
  assert.equal(range.from.toISOString().slice(0, 10), "2026-08-02");
  assert.equal(range.to.toISOString().slice(0, 10), "2026-09-10");
});

// serializeFyersRequest exists specifically because throttle()'s start-time
// pacer alone lets multiple "in flight" tasks overlap once one takes longer
// than MIN_INTERVAL_MS to settle -- under index.ts's INSTRUMENT_CONCURRENCY,
// that gap meant several real Fyers HTTP requests could be simultaneously
// in flight using the same access token (confirmed live 2026-09-11: a
// freshly-regenerated, correctly-paired token still saw ~90% of requests
// intermittently rejected with a generic 401, scattered with no pattern by
// symbol or time). These tests prove true one-at-a-time execution: a task
// never starts until the previous one has fully SETTLED, not just started.

test("serializeFyersRequest runs queued tasks strictly one at a time, never overlapping", async () => {
  let inFlight = 0;
  let maxInFlight = 0;
  const order = [];

  async function task(id, delayMs) {
    inFlight++;
    maxInFlight = Math.max(maxInFlight, inFlight);
    await sleep(delayMs);
    inFlight--;
    order.push(id);
    return id;
  }

  // Fire 5 "concurrent" callers -- as index.ts's bounded-concurrency loop
  // would -- with staggered internal delays so a naive start-time-only pacer
  // would let several overlap.
  const results = await Promise.all([
    serializeFyersRequest(() => task("A", 30)),
    serializeFyersRequest(() => task("B", 5)),
    serializeFyersRequest(() => task("C", 20)),
    serializeFyersRequest(() => task("D", 5)),
    serializeFyersRequest(() => task("E", 5)),
  ]);

  assert.equal(maxInFlight, 1, "no two tasks should ever be in flight at the same time");
  assert.deepEqual(results, ["A", "B", "C", "D", "E"]);
  // Completion order matches queue (submission) order, not each task's own delay --
  // proof the queue serializes by submission, not by whichever finishes fastest.
  assert.deepEqual(order, ["A", "B", "C", "D", "E"]);
});

test("serializeFyersRequest keeps processing later tasks after an earlier one rejects", async () => {
  const results = [];
  await Promise.allSettled([
    serializeFyersRequest(async () => {
      throw new Error("simulated Fyers failure");
    }).catch((err) => results.push({ ok: false, message: err.message })),
    serializeFyersRequest(async () => {
      await sleep(5);
      results.push({ ok: true });
      return "done";
    }),
  ]);

  assert.equal(results.length, 2);
  assert.equal(results[0].ok, false);
  assert.equal(results[1].ok, true);
});

test("serializeFyersRequest resolves each caller with its own task's own result", async () => {
  const a = serializeFyersRequest(async () => {
    await sleep(10);
    return "a-result";
  });
  const b = serializeFyersRequest(async () => "b-result");
  assert.deepEqual(await Promise.all([a, b]), ["a-result", "b-result"]);
});

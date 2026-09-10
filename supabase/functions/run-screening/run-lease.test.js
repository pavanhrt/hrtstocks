import { test } from "node:test";
import assert from "node:assert/strict";
import { acquireRunLease, heartbeatRunLease, releaseRunLease } from "./run-lease.js";

/**
 * A minimal chainable fake mirroring the subset of the supabase-js query
 * builder this module uses: .from().update().eq().or().select().maybeSingle().
 * Records every call so tests can assert on exactly what was sent, and
 * returns a pre-programmed {data, error} response for the terminal call.
 */
function fakeSupabase(response) {
  const calls = [];
  function builder() {
    const chain = {
      update: (payload) => {
        calls.push({ method: "update", payload });
        return chain;
      },
      eq: (col, val) => {
        calls.push({ method: "eq", col, val });
        return chain;
      },
      or: (expr) => {
        calls.push({ method: "or", expr });
        return chain;
      },
      select: () => {
        calls.push({ method: "select" });
        return chain;
      },
      maybeSingle: () => Promise.resolve(response),
      then: (resolve) => resolve(response), // release/heartbeat don't call maybeSingle, just await the builder
    };
    return chain;
  }
  return {
    calls,
    from(table) {
      calls.push({ method: "from", table });
      return builder();
    },
  };
}

test("acquireRunLease succeeds and reports coordinated=true when a row is returned", async () => {
  const supabase = fakeSupabase({ data: { run_type: "eod_screening", status: "active" }, error: null });
  const result = await acquireRunLease(supabase, "eod_screening", "run-123");
  assert.deepEqual(result, { acquired: true, coordinated: true });
  assert.ok(supabase.calls.some((c) => c.method === "or" && c.expr.includes("status.eq.released")));
  assert.ok(supabase.calls.some((c) => c.method === "or" && c.expr.includes("expires_at.lt.")));
});

test("acquireRunLease fails when no row matches (another run already holds a fresh lease)", async () => {
  const supabase = fakeSupabase({ data: null, error: null });
  const result = await acquireRunLease(supabase, "eod_screening", "run-123");
  assert.deepEqual(result, { acquired: false, coordinated: true });
});

test("acquireRunLease degrades gracefully when migration 0006 isn't applied yet", async () => {
  const notFoundError = Object.assign(new Error("Could not find the table 'public.screening_run_leases'"), {
    code: "PGRST205",
  });
  const supabase = fakeSupabase({ data: null, error: notFoundError });
  const result = await acquireRunLease(supabase, "eod_screening", "run-123");
  assert.deepEqual(result, { acquired: true, coordinated: false });
});

test("acquireRunLease throws on an unrelated database error", async () => {
  const supabase = fakeSupabase({ data: null, error: new Error("connection reset") });
  await assert.rejects(() => acquireRunLease(supabase, "eod_screening", "run-123"));
});

test("releaseRunLease does not throw when migration 0006 isn't applied yet", async () => {
  const notFoundError = Object.assign(new Error("not found"), { code: "PGRST205" });
  const supabase = fakeSupabase({ data: null, error: notFoundError });
  await assert.doesNotReject(() => releaseRunLease(supabase, "eod_screening"));
});

test("heartbeatRunLease does not throw when migration 0006 isn't applied yet", async () => {
  const notFoundError = Object.assign(new Error("not found"), { code: "PGRST205" });
  const supabase = fakeSupabase({ data: null, error: notFoundError });
  await assert.doesNotReject(() => heartbeatRunLease(supabase, "eod_screening"));
});

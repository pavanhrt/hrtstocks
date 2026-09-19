import { after, before, test } from "node:test";
import assert from "node:assert/strict";
import pg from "pg";
import { migrate } from "../../../../db/migrate.mjs";
import { startTestPostgres } from "../../../../db/tests/pg-harness.mjs";
import { dbFromPool } from "../db/client.js";
import { acquireRunLease, heartbeatRunLease, releaseRunLease } from "./run-lease.js";

let pgx;
let pool;
let db;

before(async () => {
  pgx = await startTestPostgres();
  const c = await pgx.newClient();
  await migrate(c);
  await c.end();
  pool = new pg.Pool({ connectionString: pgx.url, max: 8 });
  db = dbFromPool(pool);
});
after(async () => {
  await pool?.end();
  await pgx?.stop();
});

const RUN_A = "aaaaaaaa-0000-0000-0000-00000000000a";
const RUN_B = "bbbbbbbb-0000-0000-0000-00000000000b";

async function reset() {
  await pool.query("update screening_run_leases set status = 'released', run_id = null, acquired_at = null, heartbeat_at = null, expires_at = null");
}

test("the lease rows are seeded by the migrations", async () => {
  const rows = (await pool.query("select run_type from screening_run_leases order by run_type")).rows.map((r) => r.run_type);
  assert.ok(rows.includes("eod_screening"));
  assert.ok(rows.includes("buy_setup_analysis"));
});

test("a free lease is acquired; a second acquirer is refused while it is fresh", async () => {
  await reset();
  assert.deepEqual(await acquireRunLease(db, "eod_screening", RUN_A), { acquired: true });
  assert.deepEqual(await acquireRunLease(db, "eod_screening", RUN_B), { acquired: false });
});

test("under a real race, exactly one of many concurrent acquirers wins", async () => {
  await reset();
  const results = await Promise.all(Array.from({ length: 8 }, (_, i) => acquireRunLease(db, "eod_screening", `cccccccc-0000-0000-0000-${String(i).padStart(12, "0")}`)));
  assert.equal(results.filter((r) => r.acquired).length, 1);
});

test("an expired lease can be taken over; a fresh one cannot", async () => {
  await reset();
  await acquireRunLease(db, "eod_screening", RUN_A, { leaseDurationMs: -1000 }); // already expired
  assert.deepEqual(await acquireRunLease(db, "eod_screening", RUN_B), { acquired: true });
  assert.deepEqual(await acquireRunLease(db, "eod_screening", RUN_A), { acquired: false });
});

test("heartbeat extends only the holder's active lease", async () => {
  await reset();
  await acquireRunLease(db, "eod_screening", RUN_A, { leaseDurationMs: 1000 });
  await heartbeatRunLease(db, "eod_screening", RUN_B, { leaseDurationMs: 3_600_000 }); // not the holder: no effect
  const before = (await pool.query("select expires_at from screening_run_leases where run_type = 'eod_screening'")).rows[0].expires_at;
  await heartbeatRunLease(db, "eod_screening", RUN_A, { leaseDurationMs: 3_600_000 });
  const after = (await pool.query("select expires_at from screening_run_leases where run_type = 'eod_screening'")).rows[0].expires_at;
  assert.ok(new Date(after) - new Date(before) > 3_000_000);
});

test("release frees the lease for the next run, but only when called by the holder", async () => {
  await reset();
  await acquireRunLease(db, "eod_screening", RUN_A);
  await releaseRunLease(db, "eod_screening", RUN_B);
  assert.deepEqual(await acquireRunLease(db, "eod_screening", RUN_B), { acquired: false });
  await releaseRunLease(db, "eod_screening", RUN_A);
  assert.deepEqual(await acquireRunLease(db, "eod_screening", RUN_B), { acquired: true });
});

test("different run types lease independently", async () => {
  await reset();
  assert.equal((await acquireRunLease(db, "eod_screening", RUN_A)).acquired, true);
  assert.equal((await acquireRunLease(db, "buy_setup_analysis", RUN_A)).acquired, true);
});

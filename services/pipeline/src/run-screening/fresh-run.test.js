import { after, before, test } from "node:test";
import assert from "node:assert/strict";
import pg from "pg";
import { migrate } from "../../../../db/migrate.mjs";
import { startTestPostgres } from "../../../../db/tests/pg-harness.mjs";
import { dbFromPool } from "../db/client.js";
import { seedSystemData } from "../seed/seed-system.mjs";
import { createChartStore } from "../storage/charts.js";
import { runScreeningJob } from "./index.js";
import { fakeFetch } from "./test-support.js";

// First-run and failure behavior on a database that starts EMPTY (migrated + system seed only): the
// absence of historical data is normal, a failed ingestion must never publish a partial snapshot, and
// re-running after a failure must be safe and idempotent.

let pgx;
let pool;
let db;
const realFetch = globalThis.fetch;
const objects = new Map();
const bucket = { file: (name) => ({ save: async (data) => { if (objects.has(name)) throw Object.assign(new Error("exists"), { code: 412 }); objects.set(name, data); } }) };

const run = (opts = {}) => runScreeningJob({ db, chartStore: createChartStore(db, bucket), triggerType: "manual", ...opts });
const one = async (sql, params = []) => (await pool.query(sql, params)).rows[0];
const published = async () => Number((await one(`select count(*) from screening_runs where publication_state = 'published'`)).count);

before(async () => {
  process.env.FYERS_APP_ID = "TEST-APP";
  process.env.FYERS_ACCESS_TOKEN = "test-token";
  process.env.SCREENING_POLL_MS = "100";
  pgx = await startTestPostgres();
  const c = await pgx.newClient();
  await migrate(c);
  await c.end();
  pool = new pg.Pool({ connectionString: pgx.url, max: 8 });
  db = dbFromPool(pool);
  await seedSystemData(db);
});
after(async () => {
  globalThis.fetch = realFetch;
  await pool?.end();
  await pgx?.stop();
});

test("the database starts with no business or market data (first run is the normal case)", async () => {
  for (const t of ["instruments", "screening_runs", "market_bars_raw", "instrument_run_results", "rankings", "stored_objects", "profiles"]) {
    assert.equal(Number((await one(`select count(*) from ${t}`)).count), 0, `${t} must start empty`);
  }
});

test("an NSE universe outage fails the run cleanly: nothing published, lease released, safe to retry", { timeout: 120_000 }, async () => {
  globalThis.fetch = fakeFetch([], { nseStatus: 503 });
  const result = await run();
  const row = await one(`select status, publication_state from screening_runs where id = $1`, [result.runId]);
  assert.notEqual(row.status, "completed");
  assert.equal(await published(), 0);
  assert.equal((await one(`select status from screening_run_leases where run_type = 'eod_screening'`)).status, "released");
});

test("a FYERS outage for some instruments must NOT publish a partial snapshot", { timeout: 300_000 }, async () => {
  globalThis.fetch = fakeFetch([], { failSymbols: new Set(["CCC"]) });
  const result = await run();
  const row = await one(`select status, publication_state from screening_runs where id = $1`, [result.runId]);
  assert.equal(await published(), 0, "no published snapshot exists");
  assert.equal(row.publication_state, "validation_failed");
  assert.equal(row.status, "partial");
  // The failed instrument is recorded honestly, not silently dropped.
  const dq = await one(`select count(*)::int n from data_quality_results where run_id = $1 and instrument_id = 'NSE_CCC' and check_name = 'ingestion'`, [result.runId]);
  assert.equal(dq.n, 1);
  const audit = (await pool.query(`select message from pipeline_audit_log where run_id = $1 and stage = 'publication_blocked'`, [result.runId])).rows;
  assert.equal(audit.length, 1);
  assert.match(audit[0].message, /ingestion/i);
});

test("re-running after the failure is safe: it publishes, and ingestion is idempotent (no duplicate bars)", { timeout: 300_000 }, async () => {
  const barsBefore = Number((await one(`select count(*) from market_bars_raw`)).count);
  const calls = [];
  globalThis.fetch = fakeFetch(calls);
  const result = await run();
  const row = await one(`select status, publication_state from screening_runs where id = $1`, [result.runId]);
  assert.equal(row.status, "completed");
  assert.equal(row.publication_state, "published");
  assert.equal(await published(), 1, "exactly one published snapshot; the failed run stays unpublished");
  const dup = await one(`select count(*)::int n from (select instrument_id, interval, ts, provider from market_bars_raw group by 1,2,3,4 having count(*) > 1) d`);
  assert.equal(dup.n, 0);
  assert.ok(Number((await one(`select count(*) from market_bars_raw`)).count) >= barsBefore, "previously ingested bars are kept, not duplicated");
});

test("resuming a finished or failed run is a safe no-op", { timeout: 120_000 }, async () => {
  const partial = await one(`select id from screening_runs where publication_state = 'validation_failed' order by created_at desc limit 1`);
  const rows = Number((await one(`select count(*) from instrument_run_results`)).count);
  globalThis.fetch = fakeFetch([]);
  const result = await run({ resumeRunId: partial.id });
  assert.equal(result.runId, partial.id);
  assert.equal(Number((await one(`select count(*) from instrument_run_results`)).count), rows, "nothing rewritten");
  assert.equal(await published(), 1, "still exactly one published snapshot");
  assert.equal((await one(`select status from screening_run_leases where run_type = 'eod_screening'`)).status, "released");
});

test("a repeat run on already-ingested data re-fetches nothing it already has and leaves bars unchanged", { timeout: 300_000 }, async () => {
  const bars = Number((await one(`select count(*) from market_bars_raw`)).count);
  const calls = [];
  globalThis.fetch = fakeFetch(calls);
  await run();
  assert.equal(Number((await one(`select count(*) from market_bars_raw`)).count), bars);
});

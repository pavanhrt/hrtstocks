import { after, before, test } from "node:test";
import assert from "node:assert/strict";
import pg from "pg";
import { migrate } from "../../../../db/migrate.mjs";
import { startTestPostgres } from "../../../../db/tests/pg-harness.mjs";
import { dbFromPool } from "../db/client.js";
import { createChartStore } from "../storage/charts.js";
import { seedStrategies } from "../seed/seed-strategies.mjs";
import { runScreeningJob } from "./index.js";
import { STOCKS, CSV, fakeFetch, toUrl } from "./test-support.js";

// The whole EOD pipeline -- universe, ingestion, feature/rule evaluation,
// direction/swing analysis, ranking, reconciliation and transactional
// publication -- run end-to-end against a real migrated + seeded PostgreSQL,
// with only the two external APIs (NSE archive CSVs, FYERS history) faked.

let pgx;
let pool;
let db;
const realFetch = globalThis.fetch;
const uploaded = new Map();
const fakeBucket = { file: (name) => ({ save: async (data) => { if (uploaded.has(name)) throw Object.assign(new Error("exists"), { code: 412 }); uploaded.set(name, data); } }) };

before(async () => {
  pgx = await startTestPostgres();
  const c = await pgx.newClient();
  await migrate(c);
  await c.end();
  pool = new pg.Pool({ connectionString: pgx.url, max: 8 });
  db = dbFromPool(pool);
  await seedStrategies(db);
});
after(async () => {
  globalThis.fetch = realFetch;
  await pool?.end();
  await pgx?.stop();
});

test("a full screening run executes end-to-end on the migrated schema and publishes a validated snapshot", { timeout: 600_000 }, async () => {
  process.env.FYERS_APP_ID = "TEST-APP";
  process.env.FYERS_ACCESS_TOKEN = "test-token";
  process.env.SCREENING_POLL_MS = "200";
  const calls = [];
  globalThis.fetch = fakeFetch(calls);

  const chartStore = createChartStore(db, fakeBucket);
  const result = await runScreeningJob({ db, chartStore, triggerType: "manual", triggeredBy: null });
  globalThis.fetch = realFetch;

  const run = (await pool.query(`select * from screening_runs where id = $1`, [result.runId])).rows[0];
  const audit = (await pool.query(`select stage, status, message from pipeline_audit_log where run_id = $1 order by id`, [result.runId])).rows;
  const dq = (await pool.query(`select instrument_id, check_name, result, details from data_quality_results where run_id = $1 order by id limit 4`, [result.runId])).rows;
  const diagnostics = () => JSON.stringify({ run: { status: run.status, publication_state: run.publication_state }, audit: audit.filter((a) => a.status !== "ok").slice(0, 8), dq });

  // Universe: 4 indexes + 5 distinct stocks, frozen and reproducible.
  const universe = (await pool.query(`select is_index, count(*)::int as n from run_universe_instruments where run_id = $1 group by is_index order by is_index`, [result.runId])).rows;
  assert.deepEqual(universe, [{ is_index: false, n: 5 }, { is_index: true, n: 4 }], diagnostics());
  assert.equal(Number((await pool.query(`select count(*) from run_universe_sources where run_id = $1`, [result.runId])).rows[0].count), 4);

  // Every instrument got a real, persisted result -- none silently dropped.
  const results = (await pool.query(`select instrument_id, terminal_state, is_index from instrument_run_results where run_id = $1`, [result.runId])).rows;
  assert.equal(results.length, 9, diagnostics());
  assert.equal(results.filter((r) => r.terminal_state === "NO_DATA").length, 0, `no instrument should be NO_DATA with good data: ${diagnostics()}`);

  // Rules ran and are traced; ranking and coverage reconciled.
  assert.ok(Number((await pool.query(`select count(*) from rule_traces where run_id = $1`, [result.runId])).rows[0].count) > 20, diagnostics());
  const coverage = (await pool.query(`select unique_stock_count, reconciled from coverage_reconciliation where run_id = $1`, [result.runId])).rows[0];
  assert.equal(coverage.unique_stock_count, 5);
  assert.equal(coverage.reconciled, true);

  // Direction / analysis artifacts persisted and charts stored + registered.
  assert.ok(Number((await pool.query(`select count(*) from instrument_direction_runs where run_id = $1`, [result.runId])).rows[0].count) > 0);
  assert.ok(uploaded.size > 0, "charts were uploaded to the object store");
  assert.equal(Number((await pool.query(`select count(*) from stored_objects`)).rows[0].count), uploaded.size, "every uploaded chart is registered for publication checks");

  // Transactional publication succeeded and left a manifest.
  assert.equal(run.status, "completed", diagnostics());
  assert.equal(run.publication_state, "published", diagnostics());
  const manifest = (await pool.query(`select validation_errors, missing_storage_objects from run_publication_manifests where run_id = $1`, [result.runId])).rows[0];
  assert.deepEqual(manifest.validation_errors, []);
  assert.equal(manifest.missing_storage_objects, 0);

  // Lease released; only NSE archive + FYERS were contacted.
  assert.equal((await pool.query(`select status from screening_run_leases where run_type = 'eod_screening'`)).rows[0].status, "released");
  assert.deepEqual([...new Set(calls)].sort(), ["api-t1.fyers.in", "nsearchives.nseindia.com"]);
});

test("a second start while the lease is held is a harmless no-op", async () => {
  await pool.query(`update screening_run_leases set status = 'active', run_id = gen_random_uuid(), expires_at = now() + interval '5 minutes' where run_type = 'eod_screening'`);
  const before = Number((await pool.query(`select count(*) from screening_runs`)).rows[0].count);
  const result = await runScreeningJob({ db, chartStore: createChartStore(db, fakeBucket), triggerType: "scheduled" });
  assert.equal(result.status, "running");
  assert.match(result.note, /already in progress/);
  assert.equal(Number((await pool.query(`select count(*) from screening_runs`)).rows[0].count), before, "no second run row is created");
  await pool.query(`update screening_run_leases set status = 'released' where run_type = 'eod_screening'`);
});

test("an expired FYERS token fails the job with the rotation message and does not flood per-instrument NO_DATA", { timeout: 300_000 }, async () => {
  process.env.FYERS_ACCESS_TOKEN = "expired-token";
  await pool.query("delete from market_bars_raw"); // force real provider calls (the earlier run cached current bars)
  globalThis.fetch = async (input) => {
    const url = toUrl(input);
    if (url.hostname === "nsearchives.nseindia.com") return new Response(CSV, { status: 200 });
    return new Response(JSON.stringify({ s: "error", code: -16, message: "Could not authenticate the user" }), { status: 401 });
  };
  await assert.rejects(runScreeningJob({ db, chartStore: createChartStore(db, fakeBucket), triggerType: "manual" }), /FYERS rejected the access token.*runbooks\/fyers-token\.md/s);
  globalThis.fetch = realFetch;
  assert.equal((await pool.query(`select status from screening_run_leases where run_type = 'eod_screening'`)).rows[0].status, "released");
  const failed = (await pool.query(`select status from screening_runs order by created_at desc limit 1`)).rows[0];
  assert.equal(failed.status, "failed");
});

import { after, before, test } from "node:test";
import assert from "node:assert/strict";
import pg from "pg";
import { migrate } from "../../../../db/migrate.mjs";
import { startTestPostgres } from "../../../../db/tests/pg-harness.mjs";
import { dbFromPool } from "../db/client.js";
import { runFomeJob } from "./index.js";

let pgx;
let pool;
let db;
const chartStore = { putSvg: async () => {} };

before(async () => {
  pgx = await startTestPostgres();
  const c = await pgx.newClient();
  await migrate(c);
  await c.end();
  pool = new pg.Pool({ connectionString: pgx.url, max: 4 });
  db = dbFromPool(pool);
  await pool.query(`insert into instruments (id, symbol, name) values ('NSE:TCS', 'TCS', 'Tata Consultancy')`);
});
after(async () => {
  await pool?.end();
  await pgx?.stop();
});

async function queuedRun(instrumentId = "NSE:TCS") {
  return (await pool.query(`insert into fome_analysis_runs (instrument_id, status, as_of_timestamp, current_stage) values ($1, 'queued', now(), 'resolving_instrument') returning id`, [instrumentId])).rows[0].id;
}

test("a finished run is never re-run (idempotent job retries)", async () => {
  const id = (await pool.query(`insert into fome_analysis_runs (instrument_id, status, as_of_timestamp) values ('NSE:TCS', 'completed', now()) returning id`)).rows[0].id;
  assert.deepEqual(await runFomeJob({ db, chartStore, runId: id }), { runId: id, status: "completed" });
});

test("a run row that does not exist is an error, not a silent success", async () => {
  await assert.rejects(runFomeJob({ db, chartStore, runId: "00000000-0000-0000-0000-000000000000" }), /does not exist/);
});

test("an expired/missing FYERS token fails the run with a clear rotation message (no stack, no secrets)", async () => {
  delete process.env.FYERS_ACCESS_TOKEN;
  process.env.FYERS_APP_ID = "TEST-APP";
  const id = await queuedRun();
  const result = await runFomeJob({ db, chartStore, runId: id });
  assert.equal(result.status, "failed");
  const row = (await pool.query(`select status, error_message, completed_at, stage_history, providers, algorithm_version from fome_analysis_runs where id = $1`, [id])).rows[0];
  assert.match(row.error_message, /FYERS_ACCESS_TOKEN is not set/);
  assert.match(row.error_message, /runbooks\/fyers-token\.md/);
  assert.doesNotMatch(row.error_message, /\n\s+at /, "must not leak a stack trace");
  assert.ok(row.completed_at);
  assert.deepEqual(row.providers, { ohlcv: "fyers", derivatives: "fyers" });
  assert.match(row.algorithm_version, /^timeframes:/);
  // Stages advanced atomically before the failure.
  assert.ok(row.stage_history.some((s) => s.stage === "checking_cached_data"));
});

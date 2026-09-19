import { after, before, test } from "node:test";
import assert from "node:assert/strict";
import pg from "pg";
import { migrate } from "../../../../db/migrate.mjs";
import { startTestPostgres } from "../../../../db/tests/pg-harness.mjs";
import { dbFromPool } from "../db/client.js";
import { seedStrategies } from "../seed/seed-strategies.mjs";
import { runBuySetupJob } from "./index.js";

// End-to-end run of the converted buy-setup enrichment job against a real,
// migrated and seeded PostgreSQL: lease, manifest, batches, gate evaluation over
// stored daily bars, claim/reset functions, and the transactional publish step.

let pgx;
let pool;
let db;
const stored = [];
const chartStore = { putSvg: async (path) => stored.push(path) };
const RUN = "eeeeeeee-0000-0000-0000-00000000000e";

/** Daily bars: `trend` > 0 rises with pullbacks (bullish structure); 0 is flat noise. */
function bars(trend, n = 320) {
  const out = [];
  const start = new Date("2025-06-02T00:00:00Z");
  for (let i = 0; i < n; i++) {
    const d = new Date(start.getTime() + i * 86_400_000);
    if (d.getUTCDay() === 0 || d.getUTCDay() === 6) continue;
    const close = 100 + trend * i + 6 * Math.sin(i / 5);
    out.push({ date: d.toISOString().slice(0, 10), open: close - 0.5, high: close + 1.5, low: close - 1.5, close, volume: 1_000_000 + (i % 7) * 10_000 });
  }
  return out;
}

before(async () => {
  pgx = await startTestPostgres();
  const c = await pgx.newClient();
  await migrate(c);
  await c.end();
  pool = new pg.Pool({ connectionString: pgx.url, max: 6 });
  db = dbFromPool(pool);
  await seedStrategies(db);

  await pool.query(`insert into instruments (id, symbol, name, is_index) values ('NSE:UP', 'UP', 'Uptrend Ltd', false), ('NSE:FLAT', 'FLAT', 'Flat Ltd', false), ('NSE:NODATA', 'NODATA', 'No Data Ltd', false)`);
  await pool.query(`insert into screening_runs (id, run_date, universe_version, trigger_type, status, publication_state, as_of_timestamp)
                    values ($1, '2026-07-15', 'v1', 'manual', 'completed', 'published', '2026-07-15T10:00:00Z')`, [RUN]);
  await pool.query(`insert into run_universe_instruments (run_id, instrument_id, is_index) values ($1, 'NSE:UP', false), ($1, 'NSE:FLAT', false), ($1, 'NSE:NODATA', false)`, [RUN]);
  for (const [id, trend] of [["NSE:UP", 0.6], ["NSE:FLAT", 0]]) {
    for (const b of bars(trend)) {
      await pool.query(
        `insert into market_bars_raw (instrument_id, interval, session_date, ts, open, high, low, close, volume, provider, freshness, is_complete)
         values ($1, '1d', $2::date, ($2::date)::timestamptz, $3, $4, $5, $6, $7, 'fyers', 'EOD', true)`,
        [id, b.date, b.open, b.high, b.low, b.close, b.volume],
      );
    }
  }
  // Monthly / weekly Dow results from the main screening run (BSP-M1 / BSP-M3).
  for (const [id, state] of [["NSE:UP", "uptrend_intact"], ["NSE:FLAT", "sideways"]]) {
    await pool.query(
      `insert into rule_traces (run_id, instrument_id, rule_id, result, observed_values) values
         ($1, $2, 'BSP-M1', 'PASS', $3::jsonb), ($1, $2, 'BSP-M3', 'PASS', $4::jsonb)`,
      [RUN, id, JSON.stringify({ monthly_dow_state: state, monthly_range_breakout_up_with_volume: false }), JSON.stringify({ weekly_dow_state: state, weekly_range_breakout_up_with_volume: false })],
    );
  }
});
after(async () => {
  await pool?.end();
  await pgx?.stop();
});

test("with no FYERS token, an instrument that clears the gate stops the run with a clear cause", async () => {
  delete process.env.FYERS_ACCESS_TOKEN;
  process.env.FYERS_APP_ID = "TEST-APP";
  await assert.rejects(runBuySetupJob({ db, chartStore, runId: RUN }), /FYERS_ACCESS_TOKEN is not set/);

  // Gate stage ran for the COMPLETE equity universe and persisted a trace per instrument.
  const gate = (await pool.query(`select instrument_id, rule_id, result from buy_setup_gate_traces where run_id = $1 order by instrument_id, rule_id`, [RUN])).rows;
  const byInstrument = Object.groupBy(gate, (r) => r.instrument_id);
  assert.equal(Object.keys(byInstrument).length, 3, "every equity has gate traces (including the one with no data)");
  assert.equal(byInstrument["NSE:NODATA"].find((r) => r.rule_id === "BSA-G1").result, "NO_DATA");
  assert.notEqual(byInstrument["NSE:FLAT"].find((r) => r.rule_id === "BSA-G1").result, "PASS");

  // The failure is recorded on the manifest (not swallowed) and the lease is released for the next attempt.
  const manifest = (await pool.query(`select enrichment_state, validation_errors from buy_setup_manifests where run_id = $1`, [RUN])).rows[0];
  assert.equal(manifest.enrichment_state, "validation_failed");
  assert.match(manifest.validation_errors[0], /runbooks\/fyers-token\.md/);
  const lease = (await pool.query(`select status from screening_run_leases where run_type = 'buy_setup_analysis'`)).rows[0];
  assert.equal(lease.status, "released");
  // No per-instrument persistence-error flood from a token problem.
  assert.equal(Number((await pool.query(`select count(*) from buy_setup_persistence_errors where run_id = $1 and error_message like '%FYERS%'`, [RUN])).rows[0].count), 0);
});

test("a concurrent second job for the same run is refused while the lease is held", async () => {
  await pool.query(`update screening_run_leases set status = 'active', run_id = $1, expires_at = now() + interval '5 minutes' where run_type = 'buy_setup_analysis'`, [RUN]);
  const result = await runBuySetupJob({ db, chartStore, runId: RUN });
  assert.equal(result.status, "processing");
  assert.match(result.note, /already active/);
  await pool.query(`update screening_run_leases set status = 'released' where run_type = 'buy_setup_analysis'`);
});

test("a run that is not published is refused", async () => {
  await pool.query(`insert into screening_runs (id, run_date, universe_version, trigger_type, status, publication_state) values ('dddddddd-0000-0000-0000-00000000000d', '2026-07-16', 'v1', 'manual', 'running', 'processing')`);
  await assert.rejects(runBuySetupJob({ db, chartStore, runId: "dddddddd-0000-0000-0000-00000000000d" }), /not published/);
});

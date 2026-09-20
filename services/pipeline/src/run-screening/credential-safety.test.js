import { after, before, test } from "node:test";
import assert from "node:assert/strict";
import pg from "pg";
import { migrate } from "../../../../db/migrate.mjs";
import { startTestPostgres } from "../../../../db/tests/pg-harness.mjs";
import { dbFromPool } from "../db/client.js";
import { log } from "../jobs/runner.js";
import { seedSystemData } from "../seed/seed-system.mjs";
import { createChartStore } from "../storage/charts.js";
import { runScreeningJob } from "./index.js";
import { fakeFetch, STOCKS } from "./test-support.js";

// The production incident: the App ID secret ended with CR/LF, every FYERS request threw an error whose text embedded
// the whole Authorization header, and that text was persisted. These tests reproduce it end to end (real database,
// real run, a fake FYERS that validates and echoes headers like the real HTTP client) and prove that
//   1. credentials with stray CR/LF now WORK (trimmed), and
//   2. no credential, header or token-shaped value can reach ANY table, log line or error, whatever fails.

const APP_ID = "TESTAPP123-100";
// A fake JWT-shaped token, assembled at runtime so no token-looking literal sits in the repository.
const b64 = (v) => Buffer.from(typeof v === "string" ? v : JSON.stringify(v)).toString("base64url");
const TOKEN = `${b64({ alg: "HS256", typ: "JWT" })}.${b64({ aud: ["d:1"] })}.${b64("fake-signature-value")}`;
// Credential material. STRICT additionally forbids the phrase of an HTTP-client header echo (a fixed message never has it).
const FORBIDDEN = [APP_ID, TOKEN, TOKEN.slice(0, 25), TOKEN.split(".")[2].slice(0, 12), "eyJ"];
const STRICT = [...FORBIDDEN, "Headers.append"];

let pgx;
let pool;
let db;
const realFetch = globalThis.fetch;
const objects = new Map();
const bucket = { file: (name) => ({ save: async (data) => { if (objects.has(name)) throw Object.assign(new Error("exists"), { code: 412 }); objects.set(name, data); } }) };
const run = (opts = {}) => runScreeningJob({ db, chartStore: createChartStore(db, bucket), triggerType: "manual", ...opts });
const one = async (sql, params = []) => (await pool.query(sql, params)).rows[0];
const published = async () => Number((await one(`select count(*) from screening_runs where publication_state = 'published'`)).count);

/** Every text / varchar / json / jsonb / array column of every table, searched for any forbidden fragment. */
async function findLeaks(forbidden = FORBIDDEN) {
  const cols = (
    await pool.query(
      `select table_name t, column_name c from information_schema.columns
        where table_schema = 'public' and data_type in ('text', 'character varying', 'json', 'jsonb', 'ARRAY')`
    )
  ).rows;
  const hits = [];
  for (const { t, c } of cols) {
    const r = await pool.query(`select count(*)::int n from "${t}" where "${c}"::text like any ($1)`, [forbidden.map((f) => `%${f}%`)]);
    if (r.rows[0].n > 0) hits.push(`${t}.${c} (${r.rows[0].n} rows)`);
  }
  return { hits, scanned: cols.length };
}

before(async () => {
  // Deliberately dirty, exactly like the production secrets: a trailing Windows line break on both values.
  process.env.FYERS_APP_ID = `${APP_ID}\r\n`;
  process.env.FYERS_ACCESS_TOKEN = `${TOKEN}\r\n`;
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
  delete process.env.FYERS_APP_ID;
  delete process.env.FYERS_ACCESS_TOKEN;
  await pool?.end();
  await pgx?.stop();
});

test("a run where every FYERS call fails by ECHOING the header leaves no credential anywhere in the database", { timeout: 300_000 }, async () => {
  const authorizations = [];
  globalThis.fetch = fakeFetch([], { failSymbols: new Set(Object.keys(STOCKS)), authorizations, echoHeaderOnFailure: true });
  const result = await run();

  assert.ok(authorizations.length > 0, "FYERS was called");
  assert.ok(authorizations.every((a) => a === `${APP_ID}:${TOKEN}`), "the header sent had the CR/LF trimmed");
  const row = await one(`select status, publication_state from screening_runs where id = $1`, [result.runId]);
  assert.equal(await published(), 0, "a fully failed ingestion publishes nothing");
  assert.equal(row.publication_state, "validation_failed");

  // The failure itself is recorded honestly (with a fixed, non-sensitive message) ...
  const dq = await one(`select count(*)::int n, min(details::text) sample from data_quality_results where run_id = $1 and check_name = 'ingestion'`, [result.runId]);
  assert.ok(dq.n >= Object.keys(STOCKS).length, "every failed instrument has an ingestion record");
  assert.match(dq.sample, /FYERS request failed before a response was received/);
  // ... and nothing sensitive is anywhere.
  const { hits, scanned } = await findLeaks(STRICT);
  assert.ok(scanned > 50, `scanned ${scanned} text/json columns`);
  assert.deepEqual(hits, []);
});

test("credentials that carry a trailing CR/LF now work: the re-run publishes, and every header sent was clean", { timeout: 300_000 }, async () => {
  const authorizations = [];
  globalThis.fetch = fakeFetch([], { authorizations });
  const result = await run();
  const row = await one(`select status, publication_state from screening_runs where id = $1`, [result.runId]);
  assert.equal(row.status, "completed");
  assert.equal(row.publication_state, "published");
  assert.equal(await published(), 1, "exactly one snapshot is published");
  assert.ok(Number((await one(`select count(*) from market_bars_raw`)).count) > 0, "price bars were stored");
  assert.equal(Number((await one(`select count(*) from instrument_run_results where run_id = $1 and terminal_state = 'NO_DATA'`, [result.runId])).count), 0, "no NO_DATA results in this run");
  assert.ok(authorizations.length > 0 && authorizations.every((a) => a === `${APP_ID}:${TOKEN}`));
  assert.equal(Number((await one(`select count(*) from screening_run_leases where status <> 'released'`)).count), 0, "the lease is released");
  assert.deepEqual((await findLeaks()).hits, []);
});

test("even text that reaches the database from an unexpected source is redacted at the database boundary", async () => {
  const run1 = await one(`select id from screening_runs order by created_at limit 1`);
  const leaky = `Headers.append: "${APP_ID}\r\n:${TOKEN}" is an invalid header value.`;
  await db.query(`insert into pipeline_audit_log (run_id, stage, status, message) values ($1, 'test', 'warning', $2)`, [run1.id, leaky]);
  await db.query(`insert into data_quality_results (run_id, instrument_id, check_name, result, details) values ($1, 'NSE_AAA', 'boundary_test', 'NO_DATA', $2::jsonb)`, [run1.id, JSON.stringify({ error: leaky, nested: [{ note: `token ${TOKEN}` }] })]);
  const stored = await one(`select message from pipeline_audit_log where stage = 'test' and message is not null order by created_at desc limit 1`);
  assert.match(stored.message, /\[redacted\]/);
  assert.deepEqual((await findLeaks()).hits, [], "neither the message nor the JSON details kept anything");
  // Ordinary data is not disturbed by the boundary filter.
  const ordinary = await one(`select count(*)::int n from instruments where symbol in ('AAA', 'BBB')`);
  assert.equal(ordinary.n, 2);
});

test("structured job logs never carry a credential, in the message or in any field", () => {
  const lines = [];
  const original = console.log;
  console.log = (line) => lines.push(String(line));
  try {
    log("ERROR", `job screening failed: Headers.append: "${APP_ID}\r\n:${TOKEN}"`, { errorName: "TypeError", detail: `Authorization: ${APP_ID}:${TOKEN}`, result: { runId: "abc", note: TOKEN } });
  } finally {
    console.log = original;
  }
  assert.equal(lines.length, 1);
  for (const f of FORBIDDEN) assert.ok(!lines[0].includes(f), `log line contains ${f}`);
  const parsed = JSON.parse(lines[0]);
  assert.equal(parsed.severity, "ERROR");
  assert.equal(parsed.result.runId, "abc");
});

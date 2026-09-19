import { after, before, test } from "node:test";
import assert from "node:assert/strict";
import pg from "pg";
import { migrate } from "../../../../db/migrate.mjs";
import { startTestPostgres } from "../../../../db/tests/pg-harness.mjs";
import { dbFromPool } from "../db/client.js";
import { SEEDED_TABLES, seedSystemData } from "./seed-system.mjs";

let pgx;
let pool;
let db;

before(async () => {
  pgx = await startTestPostgres();
  const c = await pgx.newClient();
  await migrate(c);
  await c.end();
  pool = new pg.Pool({ connectionString: pgx.url, max: 3 });
  db = dbFromPool(pool);
});
after(async () => {
  await pool?.end();
  await pgx?.stop();
});

async function counts() {
  const tables = (await pool.query("select tablename from pg_tables where schemaname = 'public' order by 1")).rows.map((r) => r.tablename);
  const out = {};
  for (const t of tables) out[t] = Number((await pool.query(`select count(*) from "${t}"`)).rows[0].count);
  return out;
}

test("a seed on a database that was not migrated is refused", async () => {
  const fresh = await startTestPostgres();
  const p = new pg.Pool({ connectionString: fresh.url, max: 1 });
  try {
    await assert.rejects(seedSystemData(dbFromPool(p)), /relation "screening_run_leases" does not exist|run the migrations first/);
  } finally {
    await p.end();
    await fresh.stop();
  }
});

test("seeding populates ONLY the documented reference tables; no business, user, market or analysis data", async () => {
  await seedSystemData(db);
  const c = await counts();
  const populated = Object.entries(c).filter(([t, n]) => n > 0 && t !== "schema_migrations").map(([t]) => t).sort();
  assert.deepEqual(populated, ["parameter_versions", "rule_definitions", "screening_run_leases", "strategy_versions"]);
  for (const t of populated) assert.ok(SEEDED_TABLES.includes(t), `${t} is not in the documented seed list`);
  for (const t of ["profiles", "bootstrap_admin_emails", "instruments", "screening_runs", "market_bars_raw", "rankings", "stored_objects", "fundamental_score_results"]) {
    assert.equal(c[t], 0, `${t} must start empty`);
  }
  assert.ok(c.rule_definitions > 50, "the decision rules are present");
});

test("the seed is idempotent and deterministic: a second run changes nothing", async () => {
  const before = await counts();
  const registry = (await pool.query("select strategy_id, rule_version, count(*)::int n from strategy_versions group by 1, 2 order by 1, 2")).rows;
  await seedSystemData(db);
  await seedSystemData(db);
  assert.deepEqual(await counts(), before);
  assert.deepEqual((await pool.query("select strategy_id, rule_version, count(*)::int n from strategy_versions group by 1, 2 order by 1, 2")).rows, registry);
});

test("no administrator is authorized unless one is explicitly supplied; supplying one creates no account and no profile", async () => {
  assert.equal((await counts()).bootstrap_admin_emails, 0);
  const result = await seedSystemData(db, { bootstrapAdminEmail: "  Admin@Example.COM " });
  assert.equal(result.bootstrapAdmin, true);
  assert.deepEqual((await pool.query("select email from bootstrap_admin_emails")).rows, [{ email: "admin@example.com" }]);
  assert.equal((await counts()).profiles, 0, "authorizing an e-mail creates no profile until that person signs in");
  await seedSystemData(db, { bootstrapAdminEmail: "admin@example.com" });
  assert.equal((await counts()).bootstrap_admin_emails, 1, "idempotent");
});

test("a malformed administrator e-mail is rejected before anything is written", async () => {
  await assert.rejects(seedSystemData(db, { bootstrapAdminEmail: "not-an-email" }), /not a valid e-mail/);
  await assert.rejects(seedSystemData(db, { bootstrapAdminEmail: "x'; drop table profiles; --@a.co" }), /not a valid e-mail|invalid/i);
  assert.equal((await counts()).bootstrap_admin_emails, 1);
});

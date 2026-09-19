import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import fs from "node:fs";
import net from "node:net";
import path from "node:path";
import { after, before, describe, test } from "node:test";
import { fileURLToPath } from "node:url";
import pg from "pg";
import { listMigrations, migrate } from "../migrate.mjs";
import { runSmoke } from "../../scripts/qa-smoke.mjs";
import { dbFromPool } from "../../services/pipeline/src/db/client.js";
import { seedSystemData } from "../../services/pipeline/src/seed/seed-system.mjs";
import { startTestPostgres } from "./pg-harness.mjs";

// Clean-database smoke: a brand-new PostgreSQL gets ONLY migrations 0001..NNNN and the documented system seed, and
// the application must start against it. (Pipeline startup, first ingestion, first screening run and snapshot
// publication on such a database are asserted by services/pipeline/src/run-screening/fresh-run.test.js.)
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");
const standalone = path.join(root, "app", ".next", "standalone", "server.js");

let pgx;
let admin;
let pool;

before(async () => {
  pgx = await startTestPostgres();
  admin = await pgx.newClient();
  pool = new pg.Pool({ connectionString: pgx.url, max: 4 });
});
after(async () => {
  await admin?.end();
  await pool?.end();
  await pgx?.stop();
});

describe("clean database from migrations", () => {
  test("all migrations apply in order on an empty database, and a second run applies nothing", async () => {
    const files = listMigrations().map((m) => m.file);
    assert.equal(files.length, 21);
    assert.equal(files[0], "0001_schema.sql");
    assert.equal(files.at(-1), "0021_profiles_email_unique.sql");
    assert.deepEqual(await migrate(admin), files);
    assert.deepEqual(await migrate(admin), []);
  });

  test("authentication tables and role handling exist", async () => {
    const roles = (await pool.query("select unnest(enum_range(null::user_role))::text as r")).rows.map((x) => x.r);
    assert.deepEqual(roles, ["viewer", "researcher", "strategy_admin", "system_admin"]);
    const cols = (await pool.query("select column_name from information_schema.columns where table_name = 'profiles'")).rows.map((x) => x.column_name);
    for (const c of ["id", "auth_uid", "email", "role"]) assert.ok(cols.includes(c), `profiles.${c}`);
    assert.ok((await pool.query("select 1 from pg_indexes where indexname = 'profiles_email_lower_key'")).rowCount === 1, "unique e-mail index");
    assert.ok((await pool.query("select 1 from pg_tables where tablename = 'bootstrap_admin_emails'")).rowCount === 1);
    // A profile defaults to the least-privileged role.
    const p = await pool.query("insert into profiles (email) values ('smoke@example.com') returning role");
    assert.equal(p.rows[0].role, "viewer");
    await pool.query("delete from profiles where email = 'smoke@example.com'");
  });

  test("required views, functions and database roles exist", async () => {
    const views = (await pool.query("select viewname from pg_views where schemaname = 'public'")).rows.map((x) => x.viewname);
    assert.ok(views.includes("buy_setup_analysis_ledger"));
    const fns = (await pool.query("select proname from pg_proc p join pg_namespace n on n.oid = p.pronamespace where n.nspname = 'public'")).rows.map((x) => x.proname);
    for (const f of ["publish_screening_run", "publish_buy_setup_enrichment", "claim_next_pipeline_batch", "claim_next_buy_setup_batch", "reset_stale_pipeline_batches", "reset_stale_buy_setup_batches", "expire_stale_screening_runs", "try_acquire_rate_limit_slot", "try_acquire_token_bucket_slot", "publish_fundamental_refresh"]) {
      assert.ok(fns.includes(f), `function ${f}`);
    }
    const dbRoles = (await pool.query("select rolname from pg_roles where rolname in ('app_web', 'app_pipeline')")).rows.map((x) => x.rolname).sort();
    assert.deepEqual(dbRoles, ["app_pipeline", "app_web"]);
    assert.ok((await pool.query("select 1 from pg_tables where tablename = 'stored_objects'")).rowCount === 1);
  });

  test("only Cloud SQL supported, non-superuser-dependent constructs are used (one extension: pgcrypto)", async () => {
    const ext = (await pool.query("select extname from pg_extension where extname <> 'plpgsql' order by 1")).rows.map((x) => x.extname);
    assert.deepEqual(ext, ["pgcrypto"]);
  });

  test("the documented seed is the only data present, and it is idempotent", async () => {
    await seedSystemData(dbFromPool(pool));
    const tables = (await pool.query("select tablename from pg_tables where schemaname = 'public'")).rows.map((x) => x.tablename);
    const populated = [];
    for (const t of tables) if (Number((await pool.query(`select count(*) from "${t}"`)).rows[0].count) > 0) populated.push(t);
    assert.deepEqual(populated.sort(), ["parameter_versions", "rule_definitions", "schema_migrations", "screening_run_leases", "strategy_versions"]);
    await seedSystemData(dbFromPool(pool));
  });
});

describe("the built application starts against the clean database", () => {
  let server;
  let baseUrl;

  before(async (t) => {
    if (!fs.existsSync(standalone)) {
      t.skip("app is not built (run `npm --prefix app run build` first); CI builds before this suite");
      return;
    }
    const port = await new Promise((resolve) => {
      const s = net.createServer().listen(0, "127.0.0.1", () => {
        const { port } = s.address();
        s.close(() => resolve(port));
      });
    });
    baseUrl = `http://127.0.0.1:${port}`;
    server = spawn(process.execPath, [standalone], {
      cwd: path.dirname(standalone),
      env: {
        PATH: process.env.PATH,
        NODE_ENV: "production",
        PORT: String(port),
        HOSTNAME: "127.0.0.1",
        DATABASE_URL: pgx.url,
        NEXT_PUBLIC_FIREBASE_PROJECT_ID: "smoke-test-project",
        APP_BASE_URL: baseUrl,
        SIGNUP_MODE: "invite_only",
      },
      stdio: "ignore",
    });
    for (let i = 0; i < 60; i++) {
      try {
        if ((await fetch(`${baseUrl}/api/health`)).ok) return;
      } catch {
        /* not up yet */
      }
      await new Promise((r) => setTimeout(r, 500));
    }
    throw new Error("application did not start");
  });
  after(() => server?.kill());

  test("health, readiness, empty-state edge behavior, authentication enforcement and removed routes", async (t) => {
    if (!server) return t.skip("app not built");
    const results = await runSmoke({ baseUrl, expectMigrations: 21 });
    const failed = results.filter((r) => !r.pass);
    assert.deepEqual(failed, [], `failed: ${failed.map((f) => f.name).join("; ")}`);
    assert.ok(results.length >= 25);
  });
});

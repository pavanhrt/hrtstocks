import { after, before, describe, test } from "node:test";
import assert from "node:assert/strict";
import pg from "pg";
import { migrate } from "../../../../db/migrate.mjs";
import { startTestPostgres } from "../../../../db/tests/pg-harness.mjs";
import { dbFromPool, setDbForTests } from "../db/pool.ts";
import { setViewerResolverForTests, UnauthenticatedError } from "../access.ts";
import type { Viewer } from "../db/visibility.ts";
import { getCoverage, getDataQualityIssues, getIndexResults, getLatestPublishedRun, getLatestRun, getPersistenceErrorCount, getPipelineAuditLog, getRecentRuns, getRuleTracePage, getRunProgress, getStockLedger, getTierCounts, getTopCandidates } from "./runs.ts";
import { escapeLike, searchInstruments } from "./fome.ts";
import { createFomeRun, claimNewsStage } from "./fome-runs.ts";

// Real-Postgres tests of the authorization rules that used to be Supabase RLS
// (0002_rls.sql, 0010_reproducible_publication_security.sql): every rule is
// asserted for a viewer (least privilege) and for staff, plus the
// unauthenticated case.

const PUBLISHED = "11111111-1111-1111-1111-111111111111";
const PROCESSING = "22222222-2222-2222-2222-222222222222";

const viewer: Viewer = { userId: "aaaaaaaa-0000-0000-0000-000000000001", role: "viewer" };
const researcher: Viewer = { userId: "aaaaaaaa-0000-0000-0000-000000000002", role: "researcher" };
const admin: Viewer = { userId: "aaaaaaaa-0000-0000-0000-000000000003", role: "system_admin" };

let pgx: Awaited<ReturnType<typeof startTestPostgres>>;
let pool: pg.Pool;

function as(v: Viewer | null) {
  setViewerResolverForTests(async () => v);
}

before(async () => {
  pgx = await startTestPostgres();
  const admin = await pgx.newClient();
  await migrate(admin);
  await admin.query(`
    insert into instruments (id, symbol, name, is_index) values ('NSE:AAA', 'AAA', 'Alpha Ltd', false), ('NSE:BBB', 'BBB', 'Beta 100% Ltd', false), ('NSE:NIFTY', 'NIFTY', 'Nifty 50', true);
    insert into screening_runs (id, run_date, universe_version, trigger_type, status, publication_state, created_at) values
      ('${PUBLISHED}', '2026-09-15', 'v1', 'scheduled', 'completed', 'published', '2026-09-15T12:00:00Z'),
      ('${PROCESSING}', '2026-09-16', 'v1', 'manual', 'running', 'processing', '2026-09-16T12:00:00Z');
    insert into instrument_run_results (run_id, instrument_id, terminal_state, tier, is_index) values
      ('${PUBLISHED}', 'NSE:AAA', 'PASS', 'tier_a', false), ('${PUBLISHED}', 'NSE:NIFTY', 'PASS', null, true),
      ('${PROCESSING}', 'NSE:AAA', 'WATCH', 'watch', false);
    insert into rule_traces (run_id, instrument_id, rule_id, result) values
      ('${PUBLISHED}', 'NSE:AAA', 'SMM-1', 'PASS'), ('${PROCESSING}', 'NSE:AAA', 'SMM-1', 'FAIL');
    insert into rankings (run_id, instrument_id, tier) values ('${PUBLISHED}', 'NSE:AAA', 'tier_a'), ('${PROCESSING}', 'NSE:AAA', 'watch');
    insert into coverage_reconciliation (run_id, unique_stock_count, tier_a, tier_b, watch, manual_review, rejected, unavailable, reconciled) values ('${PUBLISHED}', 1, 1, 0, 0, 0, 0, 0, true), ('${PROCESSING}', 1, 0, 0, 1, 0, 0, 0, false);
    insert into data_quality_results (run_id, instrument_id, check_name, result) values ('${PUBLISHED}', 'NSE:AAA', 'bars', 'PARTIAL');
    insert into pipeline_batches (run_id, stage, status) values ('${PUBLISHED}', 'incremental', 'done');
    insert into pipeline_audit_log (run_id, stage, status, message) values ('${PUBLISHED}', 'start', 'ok', 'x');
    insert into pipeline_persistence_errors (run_id, stage, message) values ('${PUBLISHED}', 'x', 'boom');
  `);
  await admin.end();
  pool = new pg.Pool({ connectionString: pgx.url, max: 3 });
  setDbForTests(dbFromPool(pool));
});

after(async () => {
  setDbForTests(undefined);
  setViewerResolverForTests(undefined);
  await pool?.end();
  await pgx?.stop();
});

describe("unauthenticated access", () => {
  test("every repository refuses when nobody is signed in", async () => {
    as(null);
    await assert.rejects(getLatestRun(), UnauthenticatedError);
    await assert.rejects(getLatestPublishedRun(), UnauthenticatedError);
    await assert.rejects(getStockLedger(PUBLISHED), UnauthenticatedError);
    await assert.rejects(searchInstruments("a"), UnauthenticatedError);
  });
});

describe("run-scoped visibility (viewers see published runs only)", () => {
  test("getLatestRun: viewer gets the published run, staff get the newer in-progress run", async () => {
    as(viewer);
    assert.equal((await getLatestRun())?.id, PUBLISHED);
    as(researcher);
    assert.equal((await getLatestRun())?.id, PROCESSING);
  });

  test("getLatestPublishedRun ignores newer unpublished runs for everyone", async () => {
    for (const v of [viewer, researcher, admin]) {
      as(v);
      assert.equal((await getLatestPublishedRun())?.id, PUBLISHED);
    }
  });

  test("getRecentRuns hides unpublished runs from viewers", async () => {
    as(viewer);
    assert.deepEqual((await getRecentRuns()).map((r) => r.id), [PUBLISHED]);
    as(researcher);
    assert.equal((await getRecentRuns()).length, 2);
  });

  test("ledger, traces, rankings, coverage and tier counts of an unpublished run are hidden from viewers", async () => {
    as(viewer);
    assert.equal((await getStockLedger(PROCESSING)).length, 0);
    assert.equal((await getRuleTracePage(PROCESSING, "NSE:AAA")).totalCount, 0);
    assert.equal((await getTopCandidates(PROCESSING)).length, 0);
    assert.equal(await getCoverage(PROCESSING), null);
    assert.deepEqual(await getTierCounts(PROCESSING), {});
    assert.equal((await getIndexResults(PUBLISHED)).length, 1);

    as(researcher);
    assert.equal((await getStockLedger(PROCESSING)).length, 1);
    assert.equal((await getRuleTracePage(PROCESSING, "NSE:AAA")).totalCount, 1);
    assert.equal((await getTopCandidates(PROCESSING)).length, 0); // 'watch' tier is not tier_a/tier_b
    assert.notEqual(await getCoverage(PROCESSING), null);
  });

  test("published data is visible to viewers, with the instrument joined in", async () => {
    as(viewer);
    const ledger = await getStockLedger(PUBLISHED);
    assert.equal(ledger.length, 1);
    assert.equal(ledger[0].instruments?.symbol, "AAA");
    assert.deepEqual(await getTierCounts(PUBLISHED), { tier_a: 1 });
    assert.equal((await getTopCandidates(PUBLISHED))[0].instruments?.name, "Alpha Ltd");
  });
});

describe("staff-only tables", () => {
  test("viewers get empty results (what RLS returned), staff get the data", async () => {
    as(viewer);
    assert.deepEqual(await getDataQualityIssues(PUBLISHED), []);
    assert.deepEqual(await getPipelineAuditLog(PUBLISHED), []);
    assert.equal(await getRunProgress(PUBLISHED), null);
    assert.equal(await getPersistenceErrorCount(PUBLISHED), null);

    as(researcher);
    assert.equal((await getDataQualityIssues(PUBLISHED)).length, 1);
    assert.equal((await getPipelineAuditLog(PUBLISHED)).length, 1);
    assert.equal((await getRunProgress(PUBLISHED))?.batchesDone, 1);
    assert.equal(await getPersistenceErrorCount(PUBLISHED), 1);
  });
});

describe("SQL injection and input handling", () => {
  test("search input is bound as a parameter, never executed", async () => {
    as(viewer);
    const hostile = "x'; drop table instruments; --";
    assert.deepEqual(await searchInstruments(hostile), []);
    assert.equal(Number((await pool.query("select count(*) from instruments")).rows[0].count), 3);
  });

  test("LIKE wildcards in search input match literally", async () => {
    as(viewer);
    assert.equal(escapeLike("50%_\\"), "50\\%\\_\\\\");
    assert.deepEqual((await searchInstruments("%")).map((r) => r.symbol), ["BBB"]); // only 'Beta 100% Ltd' contains a literal %
    assert.deepEqual((await searchInstruments("_")).map((r) => r.symbol), []);
    assert.deepEqual((await searchInstruments("alp")).map((r) => r.symbol), ["AAA"]);
  });

  test("a hostile run id cannot break out of the query", async () => {
    as(researcher);
    await assert.rejects(getStockLedger("1' or '1'='1"), /invalid input syntax for type uuid/);
  });
});

describe("FOME run creation and news hand-off", () => {
  test("creates a queued run once and reuses it for repeat clicks (idempotent)", async () => {
    const profile = (await pool.query(`insert into profiles (email, role) values ('r@example.com', 'researcher') returning id`)).rows[0].id;
    const db = dbFromPool(pool);
    const first = await createFomeRun(db, { instrumentId: "NSE:AAA", triggeredBy: profile });
    const second = await createFomeRun(db, { instrumentId: "NSE:AAA", triggeredBy: profile });
    assert.equal(first?.reused, false);
    assert.equal(second?.reused, true);
    assert.equal(second?.runId, first?.runId);
    assert.equal(await createFomeRun(db, { instrumentId: "NSE:NOPE", triggeredBy: profile }), null);
  });

  test("only one concurrent poll can claim the news stage", async () => {
    const db = dbFromPool(pool);
    const run = (await pool.query(`select id from fome_analysis_runs limit 1`)).rows[0].id;
    const results = await Promise.all([claimNewsStage(db, run), claimNewsStage(db, run), claimNewsStage(db, run)]);
    assert.equal(results.filter(Boolean).length, 1);
  });
});

import { after, before, describe, test } from "node:test";
import assert from "node:assert/strict";
import pg from "pg";
import { migrate } from "../../../db/migrate.mjs";
import { startTestPostgres } from "../../../db/tests/pg-harness.mjs";
import { dbFromPool, setDbForTests } from "./db/pool.ts";
import { setViewerResolverForTests } from "./access.ts";
import type { Viewer } from "./db/visibility.ts";
import * as runs from "./data/runs.ts";
import * as fome from "./data/fome.ts";
import * as strategies from "./data/strategies.ts";
import * as swing from "./data/swing-analysis.ts";
import * as direction from "./data/direction.ts";
import * as buySetup from "./data/buy-setup-analysis.ts";
import * as fundamentals from "./data/fundamental-score.ts";

// A brand-new environment has NO business data. Every data function the pages call must return an ordinary
// empty value (never throw), for viewers and staff, so each page can render its empty state.

let pgx: Awaited<ReturnType<typeof startTestPostgres>>;
let pool: pg.Pool;
const RUN = "11111111-1111-1111-1111-111111111111";
const viewer: Viewer = { userId: "aaaaaaaa-0000-0000-0000-000000000001", role: "viewer" };
const admin: Viewer = { userId: "aaaaaaaa-0000-0000-0000-000000000002", role: "system_admin" };

before(async () => {
  pgx = await startTestPostgres();
  const c = await pgx.newClient();
  await migrate(c);
  await c.end();
  pool = new pg.Pool({ connectionString: pgx.url, max: 3 });
  setDbForTests(dbFromPool(pool));
});
after(async () => {
  setDbForTests(undefined);
  setViewerResolverForTests(undefined);
  await pool?.end();
  await pgx?.stop();
});

for (const [label, who] of [["viewer", viewer], ["staff", admin]] as const) {
  describe(`empty database, ${label}`, () => {
    test("run and ledger reads return empty values", async () => {
      setViewerResolverForTests(async () => who);
      assert.equal(await runs.getLatestRun(), null);
      assert.equal(await runs.getLatestPublishedRun(), null);
      assert.deepEqual(await runs.getRecentRuns(), []);
      assert.equal(await runs.getCoverage(RUN), null);
      assert.deepEqual(await runs.getTierCounts(RUN), {});
      assert.deepEqual(await runs.getIndexResults(RUN), []);
      assert.deepEqual(await runs.getTopCandidates(RUN), []);
      assert.deepEqual(await runs.getStockLedger(RUN), []);
      const page = await runs.getStockLedgerPage(RUN);
      assert.equal(page.totalCount, 0);
      assert.equal(page.pageCount, 1);
      assert.deepEqual(await runs.getRuleTraces(RUN, "X"), []);
      assert.equal((await runs.getRuleTracePage(RUN, "X")).totalCount, 0);
      assert.deepEqual((await runs.getIndexHistory()).runs, []);
      assert.deepEqual(await runs.getRuleDefinitionsByIds([]), {});
      assert.deepEqual(await runs.getRuleDefinitionsByIds(["SMM-1"]), {});
      assert.deepEqual(await runs.getDataQualityIssues(RUN), []);
      assert.equal(await runs.getRunProgress(RUN), null);
      assert.deepEqual(await runs.getPipelineAuditLog(RUN), []);
      assert.equal(await runs.getPublicationManifest(RUN), null);
      assert.ok([null, 0].includes(await runs.getPersistenceErrorCount(RUN)));
      assert.equal(await runs.getInstrument("NSE_X"), null);
      assert.equal(await runs.getInstrumentRunResult(RUN, "NSE_X"), null);
    });

    test("page-level readers return the null / empty shape the pages already handle", async () => {
      setViewerResolverForTests(async () => who);
      assert.equal(await direction.getDirectionPage(), null);
      assert.equal(await direction.getDirectionForInstrument("NSE_X"), null);
      assert.deepEqual(await swing.getAnalysisCounts(RUN), { bullish: 0, bearish: 0 });
      assert.equal((await swing.getSwingAnalysisPage(RUN, "bullish")).totalCount, 0);
      assert.equal(await buySetup.getBuySetupAnalysisPage(), null);
      assert.equal(await buySetup.getBuySetupManifest(RUN), null);
      assert.equal(await buySetup.getBuySetupInstrumentDetail("NSE_X"), null);
      assert.equal(await fundamentals.getFundamentalScoreDetail("NSE_X"), null);
      assert.deepEqual(await fome.searchInstruments("tcs"), []);
      assert.equal(await fome.getInstrumentFomeSummary("NSE_X"), null);
      assert.equal(await fome.getFomeAnalysisResult(RUN), null);
    });
  });
}

test("strategy registry reads work on an unseeded database (empty, not an error)", async () => {
  setViewerResolverForTests(async () => viewer);
  assert.deepEqual(await strategies.getStrategyVersions(), []);
  assert.deepEqual(await strategies.getRuleDefinitionsForVersion(RUN), []);
});

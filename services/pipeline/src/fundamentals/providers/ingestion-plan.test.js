import { test } from "node:test";
import assert from "node:assert/strict";
import {
  buildIngestionBatches, computeChecksum, shouldSkipUnchangedResponse, isDueForRefresh,
  FUNDAMENTAL_INSTRUMENT_CHUNK_SIZE, FUNDAMENTAL_ENDPOINTS_NON_FINANCIAL, FUNDAMENTAL_ENDPOINTS_BANK_NBFC,
} from "./ingestion-plan.js";

test("FUNDAMENTAL_ENDPOINTS_NON_FINANCIAL never includes corporate-actions -- unused by score v1", () => {
  assert.ok(!FUNDAMENTAL_ENDPOINTS_NON_FINANCIAL.includes("corporate-actions"));
});

test("FUNDAMENTAL_ENDPOINTS_NON_FINANCIAL never fetches key-ratios -- ROE/ROCE/ROA are derivable from balance-sheet + income-statement already being fetched", () => {
  assert.ok(!FUNDAMENTAL_ENDPOINTS_NON_FINANCIAL.includes("key-ratios"));
});

test("FUNDAMENTAL_ENDPOINTS_BANK_NBFC includes key-ratios -- ROA/NIM aren't otherwise derivable for a financial business", () => {
  assert.ok(FUNDAMENTAL_ENDPOINTS_BANK_NBFC.includes("key-ratios"));
  assert.ok(!FUNDAMENTAL_ENDPOINTS_BANK_NBFC.includes("corporate-actions"));
});

test("buildIngestionBatches: covers every instrument exactly once per endpoint -- no instrument silently dropped", () => {
  const instrumentIds = Array.from({ length: 25 }, (_, i) => `INSTR_${i}`);
  const batches = buildIngestionBatches(instrumentIds);
  for (const endpoint of FUNDAMENTAL_ENDPOINTS_NON_FINANCIAL) {
    const covered = batches.filter((b) => b.stage === endpoint).flatMap((b) => b.instrumentIds);
    assert.deepEqual([...covered].sort(), [...instrumentIds].sort(), `every instrument must appear exactly once for endpoint "${endpoint}"`);
  }
});

test("buildIngestionBatches: accepts an explicit endpoint set (bank/NBFC)", () => {
  const instrumentIds = ["A", "B"];
  const batches = buildIngestionBatches(instrumentIds, FUNDAMENTAL_ENDPOINTS_BANK_NBFC);
  const stages = new Set(batches.map((b) => b.stage));
  assert.deepEqual([...stages].sort(), [...FUNDAMENTAL_ENDPOINTS_BANK_NBFC].sort());
});

test("buildIngestionBatches: batches are bounded to FUNDAMENTAL_INSTRUMENT_CHUNK_SIZE instruments", () => {
  const instrumentIds = Array.from({ length: 25 }, (_, i) => `INSTR_${i}`);
  const batches = buildIngestionBatches(instrumentIds);
  for (const batch of batches) assert.ok(batch.instrumentIds.length <= FUNDAMENTAL_INSTRUMENT_CHUNK_SIZE);
});

test("buildIngestionBatches: an empty universe produces zero batches, never a spurious empty batch", () => {
  assert.deepEqual(buildIngestionBatches([]), []);
});

test("computeChecksum: deterministic -- the same raw response always hashes identically (detects unchanged re-ingestion)", async () => {
  const body = JSON.stringify({ status: "success", data: { history: [] } });
  const a = await computeChecksum(body);
  const b = await computeChecksum(body);
  assert.equal(a, b);
  assert.match(a, /^sha256:[0-9a-f]{64}$/);
});

test("computeChecksum: a different raw response hashes differently", async () => {
  const a = await computeChecksum(JSON.stringify({ x: 1 }));
  const b = await computeChecksum(JSON.stringify({ x: 2 }));
  assert.notEqual(a, b);
});

test("shouldSkipUnchangedResponse: skips only when a prior checksum exists AND matches exactly", () => {
  assert.equal(shouldSkipUnchangedResponse("sha256:abc", "sha256:abc"), true);
  assert.equal(shouldSkipUnchangedResponse("sha256:abc", "sha256:def"), false);
  assert.equal(shouldSkipUnchangedResponse(null, "sha256:abc"), false, "no prior snapshot at all must never be treated as a cache hit");
});

test("isDueForRefresh: never fetched before is always due", () => {
  assert.equal(isDueForRefresh("balance-sheet", null), true);
});

test("isDueForRefresh: within cadence is not due; past cadence is due", () => {
  const now = "2026-09-16T00:00:00Z";
  assert.equal(isDueForRefresh("balance-sheet", "2026-09-14T00:00:00Z", now), false); // 2 days ago, cadence is 7
  assert.equal(isDueForRefresh("balance-sheet", "2026-09-01T00:00:00Z", now), true); // 15 days ago
});

test("isDueForRefresh: profile's 30-day cadence is respected independently of the 7-day statement cadence", () => {
  const now = "2026-09-16T00:00:00Z";
  assert.equal(isDueForRefresh("profile", "2026-09-01T00:00:00Z", now), false); // 15 days ago, cadence is 30
  assert.equal(isDueForRefresh("profile", "2026-08-01T00:00:00Z", now), true); // 46 days ago
});

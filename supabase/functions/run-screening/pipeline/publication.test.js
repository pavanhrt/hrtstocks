import { test } from "node:test";
import assert from "node:assert/strict";
import { validatePublicationCounts } from "./publication.js";

const complete = {
  expectedEquities: 2,
  expectedIndexes: 4,
  universeSources: 4,
  resultEquities: 2,
  resultIndexes: 4,
  alignmentEquities: 2,
  eligibleEquities: 1,
  directionRows: 3,
  chartRows: 3,
  analysisBarEquities: 1,
  traceEquities: 1,
  missingAlignedAnalysis: 0,
  missingStorageObjects: 0,
  criticalPersistenceErrors: 0,
  futureAnalysisBars: 0,
  incompleteAnalysisBars: 0,
  coverageReconciled: true,
};

test("complete publication manifest is valid", () => {
  assert.deepEqual(validatePublicationCounts(complete), { valid: true, errors: [] });
});

for (const [name, patch] of [
  ["zero universe", { expectedEquities: 0, resultEquities: 0, alignmentEquities: 0 }],
  ["partial results", { resultEquities: 1 }],
  ["missing universe source", { universeSources: 3 }],
  ["missing unavailable alignment", { alignmentEquities: 1 }],
  ["missing timeframe", { directionRows: 2, chartRows: 2 }],
  ["missing chart", { chartRows: 2 }],
  ["missing analysisBars", { analysisBarEquities: 0 }],
  ["missing trace", { traceEquities: 0 }],
  ["missing directional Analysis", { missingAlignedAnalysis: 1 }],
  ["missing storage object", { missingStorageObjects: 1 }],
  ["critical persistence error", { criticalPersistenceErrors: 1 }],
  ["future candle", { futureAnalysisBars: 1 }],
  ["incomplete candle", { incompleteAnalysisBars: 1 }],
  ["coverage mismatch", { coverageReconciled: false }],
]) {
  test(`publication rejects ${name}`, () => {
    assert.equal(validatePublicationCounts({ ...complete, ...patch }).valid, false);
  });
}

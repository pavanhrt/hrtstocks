import { test } from "node:test";
import assert from "node:assert/strict";
import { selectApplicableFiling, isStandaloneOnly, isRetrievalOnly } from "./filings.js";

const CUTOFF = "2026-06-30T00:00:00Z";

test("selectApplicableFiling: excludes a filing published after the cutoff", () => {
  const filings = [
    { id: "a", period_end: "2026-03-31", available_from: "2026-05-15T00:00:00Z", consolidation: "consolidated" },
    { id: "b", period_end: "2026-06-30", available_from: "2026-07-10T00:00:00Z", consolidation: "consolidated" }, // after cutoff
  ];
  const result = selectApplicableFiling(filings, CUTOFF);
  assert.equal(result.id, "a");
});

test("selectApplicableFiling: no eligible filing returns null (NO_DATA at the caller), never falls back to a future one", () => {
  const filings = [{ id: "a", period_end: "2026-09-30", available_from: "2026-10-01T00:00:00Z", consolidation: "consolidated" }];
  assert.equal(selectApplicableFiling(filings, CUTOFF), null);
});

test("selectApplicableFiling: prefers the latest eligible period over an earlier one", () => {
  const filings = [
    { id: "old", period_end: "2025-12-31", available_from: "2026-02-01T00:00:00Z", consolidation: "consolidated" },
    { id: "new", period_end: "2026-03-31", available_from: "2026-05-15T00:00:00Z", consolidation: "consolidated" },
  ];
  assert.equal(selectApplicableFiling(filings, CUTOFF).id, "new");
});

test("selectApplicableFiling: prefers consolidated over standalone for the same period", () => {
  const filings = [
    { id: "standalone", period_end: "2026-03-31", available_from: "2026-05-15T00:00:00Z", consolidation: "standalone" },
    { id: "consolidated", period_end: "2026-03-31", available_from: "2026-05-16T00:00:00Z", consolidation: "consolidated" },
  ];
  assert.equal(selectApplicableFiling(filings, CUTOFF).id, "consolidated");
});

test("selectApplicableFiling: falls back to standalone when no consolidated statement exists for that period", () => {
  const filings = [{ id: "standalone", period_end: "2026-03-31", available_from: "2026-05-15T00:00:00Z", consolidation: "standalone" }];
  assert.equal(selectApplicableFiling(filings, CUTOFF).id, "standalone");
});

test("selectApplicableFiling: an eligible revision (published before cutoff) is preferred over the original it supersedes", () => {
  const filings = [
    { id: "original", period_end: "2026-03-31", available_from: "2026-05-01T00:00:00Z", consolidation: "consolidated" },
    { id: "revision", period_end: "2026-03-31", available_from: "2026-05-20T00:00:00Z", consolidation: "consolidated", supersedes_id: "original" },
  ];
  assert.equal(selectApplicableFiling(filings, CUTOFF).id, "revision");
});

test("selectApplicableFiling: a revision published AFTER the cutoff must never be selected -- the original stands for that cutoff", () => {
  const filings = [
    { id: "original", period_end: "2026-03-31", available_from: "2026-05-01T00:00:00Z", consolidation: "consolidated" },
    { id: "revision", period_end: "2026-03-31", available_from: "2026-08-01T00:00:00Z", consolidation: "consolidated", supersedes_id: "original" }, // after cutoff
  ];
  assert.equal(selectApplicableFiling(filings, CUTOFF).id, "original");
});

test("old published runs remain unchanged after later filings: re-running selection with the SAME historical cutoff after a new filing arrives yields the identical result", () => {
  const filingsBefore = [{ id: "q1", period_end: "2026-03-31", available_from: "2026-05-01T00:00:00Z", consolidation: "consolidated" }];
  const resultBefore = selectApplicableFiling(filingsBefore, CUTOFF);

  // A brand-new filing arrives, published well after CUTOFF.
  const filingsAfter = [...filingsBefore, { id: "q2", period_end: "2026-06-30", available_from: "2026-08-05T00:00:00Z", consolidation: "consolidated" }];
  const resultAfter = selectApplicableFiling(filingsAfter, CUTOFF);

  assert.deepEqual(resultAfter, resultBefore, "a later filing must never change what an earlier cutoff resolves to");
});

test("selectApplicableFiling: invalid cutoff throws rather than silently matching everything", () => {
  assert.throws(() => selectApplicableFiling([], "not-a-date"));
});

test("isStandaloneOnly: true only when the selected period has no consolidated statement at all", () => {
  const standaloneOnly = [{ id: "s", period_end: "2026-03-31", available_from: "2026-05-01T00:00:00Z", consolidation: "standalone" }];
  const selected = selectApplicableFiling(standaloneOnly, CUTOFF);
  assert.equal(isStandaloneOnly(standaloneOnly, selected), true);

  const both = [
    { id: "s", period_end: "2026-03-31", available_from: "2026-05-01T00:00:00Z", consolidation: "standalone" },
    { id: "c", period_end: "2026-03-31", available_from: "2026-05-02T00:00:00Z", consolidation: "consolidated" },
  ];
  const selectedBoth = selectApplicableFiling(both, CUTOFF);
  assert.equal(isStandaloneOnly(both, selectedBoth), false);
});

test("isRetrievalOnly: true only for a RETRIEVAL_ONLY basis (e.g. Upstox) -- must be disclosed on the detail page", () => {
  assert.equal(isRetrievalOnly({ timestamp_basis: "RETRIEVAL_ONLY" }), true);
  assert.equal(isRetrievalOnly({ timestamp_basis: "EXCHANGE_FILING" }), false);
  assert.equal(isRetrievalOnly(null), false);
});

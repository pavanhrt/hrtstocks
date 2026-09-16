import { test } from "node:test";
import assert from "node:assert/strict";
import { resolveFundamentalBinding } from "./binding.js";

const RUN_AS_OF = "2026-06-30T00:00:00Z";

test("resolveFundamentalBinding: a later filing (later cutoff, same version) cannot change an old run's binding once resolved for that run's own as_of", () => {
  const beforeNewFiling = [
    { id: 1, instrument_id: "X", cutoff_at: "2026-03-31T00:00:00Z", score_version_id: 1 },
  ];
  const resolvedBefore = resolveFundamentalBinding(beforeNewFiling, RUN_AS_OF);

  // A brand-new, later-cutoff result arrives (simulating a new filing), but
  // it postdates this specific run's own as_of_timestamp.
  const afterNewFiling = [
    ...beforeNewFiling,
    { id: 2, instrument_id: "X", cutoff_at: "2026-08-01T00:00:00Z", score_version_id: 1 },
  ];
  const resolvedAfter = resolveFundamentalBinding(afterNewFiling, RUN_AS_OF);

  assert.deepEqual(resolvedAfter, resolvedBefore, "a result published after this run's own as_of must never be selected for it");
  assert.equal(resolvedAfter.id, 1);
});

test("resolveFundamentalBinding: a later score version cannot change an old run's binding when its own cutoff is not eligible", () => {
  const v1Only = [{ id: 1, instrument_id: "X", cutoff_at: "2026-03-31T00:00:00Z", score_version_id: 1 }];
  const resolvedV1 = resolveFundamentalBinding(v1Only, RUN_AS_OF);

  // A new score_version (2) recomputes the SAME evidence but at a cutoff
  // that postdates this run's as_of -- must not be preferred just because
  // its version number is higher.
  const withNewerVersionButIneligibleCutoff = [
    ...v1Only,
    { id: 3, instrument_id: "X", cutoff_at: "2026-09-01T00:00:00Z", score_version_id: 2 },
  ];
  const resolvedStill = resolveFundamentalBinding(withNewerVersionButIneligibleCutoff, RUN_AS_OF);
  assert.deepEqual(resolvedStill, resolvedV1);
});

test("resolveFundamentalBinding: when two eligible results share the exact same cutoff, the newer score_version wins deterministically", () => {
  const candidates = [
    { id: 1, instrument_id: "X", cutoff_at: "2026-03-31T00:00:00Z", score_version_id: 1 },
    { id: 2, instrument_id: "X", cutoff_at: "2026-03-31T00:00:00Z", score_version_id: 2 },
  ];
  const resolved = resolveFundamentalBinding(candidates, RUN_AS_OF);
  assert.equal(resolved.id, 2);
});

test("resolveFundamentalBinding: no eligible candidate returns null (NO_DATA), never falls back to an ineligible one", () => {
  const onlyFuture = [{ id: 1, instrument_id: "X", cutoff_at: "2026-12-01T00:00:00Z", score_version_id: 1 }];
  assert.equal(resolveFundamentalBinding(onlyFuture, RUN_AS_OF), null);
  assert.equal(resolveFundamentalBinding([], RUN_AS_OF), null);
});

test("resolveFundamentalBinding: deterministic and idempotent across repeated calls with the same inputs", () => {
  const candidates = [
    { id: 1, instrument_id: "X", cutoff_at: "2026-01-01T00:00:00Z", score_version_id: 1 },
    { id: 2, instrument_id: "X", cutoff_at: "2026-04-01T00:00:00Z", score_version_id: 1 },
    { id: 3, instrument_id: "X", cutoff_at: "2026-02-01T00:00:00Z", score_version_id: 2 },
  ];
  const results = Array.from({ length: 10 }, () => resolveFundamentalBinding(candidates, RUN_AS_OF));
  for (const r of results) assert.deepEqual(r, results[0]);
  assert.equal(results[0].id, 2); // latest eligible cutoff (Apr) beats the higher version at an earlier cutoff (Feb)
});

test("resolveFundamentalBinding: main-table and detail-page lookups agree because both call this same function against the same candidate set", () => {
  // Simulates the ledger view (main table) and getFundamentalScoreDetail
  // (detail page) each independently resolving a binding for the same
  // (instrument, run) pair from the same underlying rows -- they must agree.
  const candidates = [
    { id: 1, instrument_id: "X", cutoff_at: "2026-01-01T00:00:00Z", score_version_id: 1 },
    { id: 2, instrument_id: "X", cutoff_at: "2026-05-01T00:00:00Z", score_version_id: 1 },
  ];
  const mainTableLookup = resolveFundamentalBinding(candidates, RUN_AS_OF);
  const detailPageLookup = resolveFundamentalBinding(candidates, RUN_AS_OF);
  assert.deepEqual(mainTableLookup, detailPageLookup);
});

test("resolveFundamentalBinding: throws on an invalid as-of timestamp rather than silently matching everything", () => {
  assert.throws(() => resolveFundamentalBinding([], "not-a-date"));
});

import { test } from "node:test";
import assert from "node:assert/strict";
import { resolveSortColumn, buildSortSpecs } from "./buy-setup-sort.ts";

test("resolveSortColumn: recognizes each sortable column, defaults to symbol", () => {
  assert.equal(resolveSortColumn("overall_status"), "overall_status");
  assert.equal(resolveSortColumn("gate_result"), "gate_result");
  assert.equal(resolveSortColumn("fundamental_score"), "fundamental_score");
  assert.equal(resolveSortColumn("symbol"), "symbol");
  assert.equal(resolveSortColumn(undefined), "symbol");
  assert.equal(resolveSortColumn("not-a-real-column"), "symbol");
});

test("buildSortSpecs: fundamental_score ascending puts nulls LAST (numeric scores first)", () => {
  const [primary] = buildSortSpecs("fundamental_score", "asc");
  assert.equal(primary.column, "fundamental_score");
  assert.equal(primary.ascending, true);
  assert.equal(primary.nullsFirst, false, "NO_DATA/null must never appear before a real score, even ascending");
});

test("buildSortSpecs: fundamental_score descending ALSO puts nulls LAST -- this is the bug fix", () => {
  const [primary] = buildSortSpecs("fundamental_score", "desc");
  assert.equal(primary.ascending, false);
  assert.equal(primary.nullsFirst, false, "descending must still show real scores before NO_DATA, not Postgres' default NULLS FIRST for DESC");
});

test("buildSortSpecs: non-nullable columns (symbol/gate_result/overall_status) keep ordinary direction-relative null placement", () => {
  const [ascSpec] = buildSortSpecs("symbol", "asc");
  const [descSpec] = buildSortSpecs("symbol", "desc");
  assert.equal(ascSpec.nullsFirst, false);
  assert.equal(descSpec.nullsFirst, true);
});

test("buildSortSpecs: always appends a stable instrument_id ascending tie-breaker", () => {
  const [, tieBreaker] = buildSortSpecs("fundamental_score", "desc");
  assert.deepEqual(tieBreaker, { column: "instrument_id", ascending: true, nullsFirst: false });
});

test("buildSortSpecs: defaults to symbol/asc when no sort params are given", () => {
  const [primary] = buildSortSpecs(undefined, undefined);
  assert.equal(primary.column, "symbol");
  assert.equal(primary.ascending, true);
});

test("buildSortSpecs: is deterministic across repeated calls with the same inputs (pagination stability)", () => {
  const calls = Array.from({ length: 5 }, () => buildSortSpecs("fundamental_score", "desc"));
  for (const c of calls) assert.deepEqual(c, calls[0]);
});

import { test } from "node:test";
import assert from "node:assert/strict";
import { buildChunks } from "./chunks.js";

test("buildChunks splits evenly when the list divides exactly", () => {
  const items = Array.from({ length: 6 }, (_, i) => `S${i}`);
  const chunks = buildChunks(items, 2);
  assert.deepEqual(chunks, [["S0", "S1"], ["S2", "S3"], ["S4", "S5"]]);
});

test("buildChunks leaves a smaller last chunk for a remainder", () => {
  const items = Array.from({ length: 7 }, (_, i) => `S${i}`);
  const chunks = buildChunks(items, 3);
  assert.equal(chunks.length, 3);
  assert.deepEqual(chunks[2], ["S6"]);
});

test("buildChunks on an empty list returns no chunks", () => {
  assert.deepEqual(buildChunks([], 10), []);
});

test("buildChunks with chunkSize >= list length returns one chunk", () => {
  const items = ["A", "B", "C"];
  assert.deepEqual(buildChunks(items, 100), [["A", "B", "C"]]);
});

test("buildChunks preserves input order and never drops/duplicates items", () => {
  const items = Array.from({ length: 501 }, (_, i) => `NSE_${i}`);
  const chunks = buildChunks(items, 60);
  assert.equal(chunks.length, 9); // ceil(501/60)
  const flattened = chunks.flat();
  assert.deepEqual(flattened, items);
});

test("buildChunks throws on a non-positive chunk size", () => {
  assert.throws(() => buildChunks(["A"], 0));
  assert.throws(() => buildChunks(["A"], -1));
});

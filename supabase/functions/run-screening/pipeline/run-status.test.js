import { test } from "node:test";
import assert from "node:assert/strict";
import { decideRunStatus } from "./run-status.js";

const maxDurationMs = 40 * 60 * 1000;

test("stays 'running' while incremental batches are still pending, under the duration cap", () => {
  const status = decideRunStatus({
    batches: [
      { stage: "universe", status: "done" },
      { stage: "incremental", status: "pending" },
      { stage: "reconcile", status: "pending" },
    ],
    universeCount: 501,
    resultCount: 60,
    elapsedMs: 5 * 60_000,
    maxDurationMs,
  });
  assert.equal(status, "running");
});

test("stays 'running' while a batch is in_progress, under the duration cap", () => {
  const status = decideRunStatus({
    batches: [
      { stage: "universe", status: "done" },
      { stage: "incremental", status: "in_progress" },
      { stage: "reconcile", status: "pending" },
    ],
    universeCount: 501,
    resultCount: 120,
    elapsedMs: 60_000,
    maxDurationMs,
  });
  assert.equal(status, "running");
});

test("'completed' once every blocking batch is done and every expected instrument has a result", () => {
  const status = decideRunStatus({
    batches: [
      { stage: "universe", status: "done" },
      { stage: "incremental", status: "done" },
      { stage: "reconcile", status: "done" },
    ],
    universeCount: 501,
    resultCount: 501,
    elapsedMs: 8 * 60_000,
    maxDurationMs,
  });
  assert.equal(status, "completed");
});

test("'completed' even with backfill batches still pending -- backfill never blocks completion", () => {
  const status = decideRunStatus({
    batches: [
      { stage: "universe", status: "done" },
      { stage: "incremental", status: "done" },
      { stage: "backfill", status: "pending" },
      { stage: "backfill", status: "pending" },
      { stage: "reconcile", status: "done" },
    ],
    universeCount: 501,
    resultCount: 501,
    elapsedMs: 8 * 60_000,
    maxDurationMs,
  });
  assert.equal(status, "completed");
});

test("'partial' when the duration cap is exceeded while blocking work is still pending", () => {
  const status = decideRunStatus({
    batches: [
      { stage: "universe", status: "done" },
      { stage: "incremental", status: "pending" },
      { stage: "reconcile", status: "pending" },
    ],
    universeCount: 501,
    resultCount: 180,
    elapsedMs: 41 * 60_000,
    maxDurationMs,
  });
  assert.equal(status, "partial");
});

test("'partial' when a blocking batch permanently failed, even if every instrument technically got a row", () => {
  // A chunk that exhausted its retries gets honest "gave up" terminal rows
  // inserted for its instruments (see index.ts), which can make resultCount
  // look fully covered -- but the batch itself is marked 'failed', so the
  // run must not claim every result came from a genuine attempt.
  const status = decideRunStatus({
    batches: [
      { stage: "universe", status: "done" },
      { stage: "incremental", status: "failed" },
      { stage: "reconcile", status: "done" },
    ],
    universeCount: 501,
    resultCount: 501,
    elapsedMs: 10 * 60_000,
    maxDurationMs,
  });
  assert.equal(status, "partial");
});

test("'partial' when blocking work is done but coverage still falls short of the expected universe", () => {
  const status = decideRunStatus({
    batches: [
      { stage: "universe", status: "done" },
      { stage: "incremental", status: "done" },
      { stage: "reconcile", status: "done" },
    ],
    universeCount: 501,
    resultCount: 480,
    elapsedMs: 10 * 60_000,
    maxDurationMs,
  });
  assert.equal(status, "partial");
});

test("a slow-but-fully-covered run past the duration cap is still 'completed', not punished for being slow", () => {
  const status = decideRunStatus({
    batches: [
      { stage: "universe", status: "done" },
      { stage: "incremental", status: "done" },
      { stage: "reconcile", status: "done" },
    ],
    universeCount: 501,
    resultCount: 501,
    elapsedMs: 45 * 60_000,
    maxDurationMs,
  });
  assert.equal(status, "completed");
});

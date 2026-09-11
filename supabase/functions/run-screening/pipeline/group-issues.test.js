import { test } from "node:test";
import assert from "node:assert/strict";
import { groupDataQualityIssues, groupAuditLog } from "./group-issues.js";

test("groupDataQualityIssues collapses repeated identical causes into one group with a count", () => {
  const rows = Array.from({ length: 487 }, (_, i) => ({
    check_name: "ingestion",
    result: "NO_DATA",
    instrument_id: `NSE_STOCK${i}`,
    created_at: `2026-09-10T15:0${i % 9}:00Z`,
  }));
  const groups = groupDataQualityIssues(rows);
  assert.equal(groups.length, 1);
  assert.equal(groups[0].count, 487);
  assert.equal(groups[0].check_name, "ingestion");
  assert.equal(groups[0].result, "NO_DATA");
});

test("groupDataQualityIssues caps the sample instrument list at sampleLimit", () => {
  const rows = Array.from({ length: 20 }, (_, i) => ({
    check_name: "ingestion",
    result: "NO_DATA",
    instrument_id: `NSE_STOCK${i}`,
    created_at: "2026-09-10T15:00:00Z",
  }));
  const groups = groupDataQualityIssues(rows, 5);
  assert.equal(groups[0].sample_instrument_ids.length, 5);
});

test("groupDataQualityIssues keeps distinct (check_name, result) pairs as separate groups, sorted by count desc", () => {
  const rows = [
    ...Array.from({ length: 3 }, (_, i) => ({ check_name: "ingestion", result: "NO_DATA", instrument_id: `A${i}`, created_at: "2026-09-10T10:00:00Z" })),
    ...Array.from({ length: 10 }, (_, i) => ({ check_name: "bar_validation", result: "PARTIAL", instrument_id: `B${i}`, created_at: "2026-09-10T11:00:00Z" })),
  ];
  const groups = groupDataQualityIssues(rows);
  assert.equal(groups.length, 2);
  assert.equal(groups[0].check_name, "bar_validation"); // 10 > 3, sorted first
  assert.equal(groups[1].check_name, "ingestion");
});

test("groupDataQualityIssues tracks first_seen/last_seen across the group", () => {
  const rows = [
    { check_name: "ingestion", result: "NO_DATA", instrument_id: "A", created_at: "2026-09-10T15:05:00Z" },
    { check_name: "ingestion", result: "NO_DATA", instrument_id: "B", created_at: "2026-09-10T15:01:00Z" },
    { check_name: "ingestion", result: "NO_DATA", instrument_id: "C", created_at: "2026-09-10T15:09:00Z" },
  ];
  const groups = groupDataQualityIssues(rows);
  assert.equal(groups[0].first_seen, "2026-09-10T15:01:00Z");
  assert.equal(groups[0].last_seen, "2026-09-10T15:09:00Z");
});

test("groupDataQualityIssues on an empty list returns no groups", () => {
  assert.deepEqual(groupDataQualityIssues([]), []);
});

test("groupAuditLog collapses by (stage, status) with a sample of messages", () => {
  const rows = [
    { stage: "hourly_ingest", status: "warning", message: "instrument A failed", created_at: "2026-09-10T10:00:00Z" },
    { stage: "hourly_ingest", status: "warning", message: "instrument B failed", created_at: "2026-09-10T10:01:00Z" },
    { stage: "start", status: "ok", message: "Run started (manual)", created_at: "2026-09-10T09:59:00Z" },
  ];
  const groups = groupAuditLog(rows);
  assert.equal(groups.length, 2);
  const hourly = groups.find((g) => g.stage === "hourly_ingest");
  assert.equal(hourly.count, 2);
  assert.equal(hourly.sample_messages.length, 2);
});

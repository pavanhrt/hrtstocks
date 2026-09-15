import { test } from "node:test";
import assert from "node:assert/strict";
import { overallStatusFor } from "./buy-setup-status.ts";

test("overallStatusFor: NO_DATA gate stays NO_DATA regardless of qualification", () => {
  assert.equal(overallStatusFor("NO_DATA", false, null), "NO_DATA");
});

test("overallStatusFor: a FAIL gate is FAIL, never downstream MANUAL_REVIEW/NO_DATA", () => {
  assert.equal(overallStatusFor("FAIL", false, null), "FAIL");
});

test("overallStatusFor: an unresolved gate result (not PASS/FAIL/NO_DATA) is MANUAL_REVIEW", () => {
  assert.equal(overallStatusFor("MANUAL_REVIEW", false, null), "MANUAL_REVIEW");
});

test("overallStatusFor: gate PASS but not actually qualified is MANUAL_REVIEW, never a silent pass-through", () => {
  assert.equal(overallStatusFor("PASS", false, null), "MANUAL_REVIEW");
});

test("overallStatusFor: qualified but 15-minute data missing is NO_DATA, not TECHNICAL_EVIDENCE_PRESENT", () => {
  assert.equal(overallStatusFor("PASS", true, "NO_DATA"), "NO_DATA");
  assert.equal(overallStatusFor("PASS", true, null), "NO_DATA");
});

test("overallStatusFor: qualified with 15-minute data present is TECHNICAL_EVIDENCE_PRESENT", () => {
  assert.equal(overallStatusFor("PASS", true, "PASS"), "TECHNICAL_EVIDENCE_PRESENT");
});

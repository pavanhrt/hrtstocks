import { test } from "node:test";
import assert from "node:assert/strict";
import { parseNseConstituentCsv } from "./nse-archives.js";

test("parses an immutable NSE constituent snapshot", () => {
  const rows = parseNseConstituentCsv("Company Name,Industry,Symbol\nTata Consultancy Services,IT,TCS\n", "nifty-50");
  assert.deepEqual(rows, [{ instrumentId: "NSE_TCS", symbol: "TCS", name: "Tata Consultancy Services" }]);
});

test("rejects empty, malformed, or duplicate constituent snapshots", () => {
  assert.throws(() => parseNseConstituentCsv("", "nifty-50"), /Empty/);
  assert.throws(() => parseNseConstituentCsv("Company Name\nTata\n", "nifty-50"), /header/);
  assert.throws(() => parseNseConstituentCsv("Company Name,Symbol\nTata,TCS\nTata,TCS\n", "nifty-50"), /Duplicate/);
});

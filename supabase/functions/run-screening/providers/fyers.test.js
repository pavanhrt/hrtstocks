import { test } from "node:test";
import assert from "node:assert/strict";
import { nextIncrementalRange } from "./fyers.js";

// fetchOHLCV/fetchOHLCVRange/fetchHourlyOHLCV are real network I/O (Fyers'
// live API) -- same convention as the rest of this codebase (no test doubles
// for outbound fetch), so only the pure date-range decision is unit-tested
// here.

test("nextIncrementalRange falls back to the full lookback window when no bar has ever been stored", () => {
  const range = nextIncrementalRange(null, "2026-09-10", 365);
  assert.equal(range.to.toISOString().slice(0, 10), "2026-09-10");
  assert.equal(range.from.toISOString().slice(0, 10), "2025-09-10");
});

test("nextIncrementalRange fetches only the day after the latest stored bar through the run date", () => {
  const range = nextIncrementalRange("2026-09-08", "2026-09-10", 365);
  assert.equal(range.from.toISOString().slice(0, 10), "2026-09-09");
  assert.equal(range.to.toISOString().slice(0, 10), "2026-09-10");
});

test("nextIncrementalRange returns null when the latest stored bar already covers the run date (retry/idempotent case)", () => {
  assert.equal(nextIncrementalRange("2026-09-10", "2026-09-10", 365), null);
});

test("nextIncrementalRange returns null when the latest stored bar is even newer than the run date", () => {
  assert.equal(nextIncrementalRange("2026-09-11", "2026-09-10", 365), null);
});

test("nextIncrementalRange handles a multi-day gap (e.g. a stock skipped for several runs)", () => {
  const range = nextIncrementalRange("2026-08-01", "2026-09-10", 365);
  assert.equal(range.from.toISOString().slice(0, 10), "2026-08-02");
  assert.equal(range.to.toISOString().slice(0, 10), "2026-09-10");
});

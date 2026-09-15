import { test } from "node:test";
import assert from "node:assert/strict";
import { normalizeCompletedFifteenMinuteBars, fifteenMinuteBarBoundaries } from "./fifteen-minute-bars.js";

function candle(tsIso, overrides = {}) {
  return { ts: Math.floor(new Date(tsIso).getTime() / 1000), open: 100, high: 101, low: 99, close: 100.5, volume: 1000, ...overrides };
}

test("fifteenMinuteBarBoundaries: exactly 25 windows covering 09:15-15:30 IST with no gaps or overlaps", () => {
  const bounds = fifteenMinuteBarBoundaries();
  assert.equal(bounds.length, 25);
  assert.equal(bounds[0].start, "09:15");
  assert.equal(bounds[bounds.length - 1].end, "15:30");
  for (let i = 1; i < bounds.length; i++) {
    assert.equal(bounds[i].start, bounds[i - 1].end, "windows must be contiguous");
  }
});

test("fifteenMinuteBarBoundaries includes the final 15:15-15:30 window as a real (not excluded stub) candle", () => {
  const bounds = fifteenMinuteBarBoundaries();
  assert.ok(bounds.some((b) => b.start === "15:15" && b.end === "15:30"));
});

// 2026-09-11 is a confirmed NSE trading day (Friday) used throughout this
// project's own screening runs this session.
const TRADING_DAY = "2026-09-11";

test("accepts a candle whose IST start time is a real 15-minute boundary", () => {
  // 09:15 IST = 03:45 UTC.
  const raw = [candle(`${TRADING_DAY}T03:45:00Z`)];
  const bars = normalizeCompletedFifteenMinuteBars(raw, `${TRADING_DAY}T23:59:00Z`);
  assert.equal(bars.length, 1);
  assert.equal(bars[0].sessionDate, TRADING_DAY);
});

test("rejects an off-grid candle (not aligned to any 15-minute boundary)", () => {
  // 09:20 IST = 03:50 UTC -- 5 minutes off-grid.
  const raw = [candle(`${TRADING_DAY}T03:50:00Z`)];
  const bars = normalizeCompletedFifteenMinuteBars(raw, `${TRADING_DAY}T23:59:00Z`);
  assert.equal(bars.length, 0);
});

test("rejects a pre-open candle (before 09:15 IST)", () => {
  // 09:00 IST = 03:30 UTC.
  const raw = [candle(`${TRADING_DAY}T03:30:00Z`)];
  const bars = normalizeCompletedFifteenMinuteBars(raw, `${TRADING_DAY}T23:59:00Z`);
  assert.equal(bars.length, 0);
});

test("rejects a post-close candle (15:30 IST or later)", () => {
  // 15:30 IST = 10:00 UTC -- session close, not a valid bar start.
  const raw = [candle(`${TRADING_DAY}T10:00:00Z`)];
  const bars = normalizeCompletedFifteenMinuteBars(raw, `${TRADING_DAY}T23:59:00Z`);
  assert.equal(bars.length, 0);
});

test("accepts the final 15:15-15:30 IST candle as a real completed bar (not treated as an excluded stub)", () => {
  // 15:15 IST = 09:45 UTC.
  const raw = [candle(`${TRADING_DAY}T09:45:00Z`)];
  const bars = normalizeCompletedFifteenMinuteBars(raw, `${TRADING_DAY}T23:59:00Z`);
  assert.equal(bars.length, 1);
});

test("rejects a candle on a weekend date even if its clock time is a valid boundary", () => {
  // 2026-09-13 is a Sunday.
  const raw = [candle("2026-09-13T03:45:00Z")];
  const bars = normalizeCompletedFifteenMinuteBars(raw, "2026-09-13T23:59:00Z");
  assert.equal(bars.length, 0);
});

test("rejects a candle on a listed NSE holiday even if its clock time is a valid boundary", () => {
  // 2026-09-14 is Ganesh Chaturthi (nse-calendar.js's NSE_HOLIDAYS_2026).
  const raw = [candle("2026-09-14T03:45:00Z")];
  const bars = normalizeCompletedFifteenMinuteBars(raw, "2026-09-14T23:59:00Z");
  assert.equal(bars.length, 0);
});

test("excludes a candle still in progress at the cutoff (incomplete 15-minute candle filtering)", () => {
  const raw = [candle(`${TRADING_DAY}T03:45:00Z`)]; // 09:15-09:30 IST
  const bars = normalizeCompletedFifteenMinuteBars(raw, `${TRADING_DAY}T03:50:00Z`); // cutoff mid-candle (09:20 IST)
  assert.equal(bars.length, 0);
});

test("includes a candle that closed exactly at the cutoff", () => {
  const raw = [candle(`${TRADING_DAY}T03:45:00Z`)]; // ends 09:30 IST = 04:00 UTC
  const bars = normalizeCompletedFifteenMinuteBars(raw, `${TRADING_DAY}T04:00:00Z`);
  assert.equal(bars.length, 1);
});

test("never includes a candle whose close is after the run cutoff (run-cutoff/EOD-cutoff enforcement)", () => {
  const raw = [candle(`${TRADING_DAY}T03:45:00Z`), candle(`${TRADING_DAY}T04:00:00Z`), candle(`${TRADING_DAY}T04:15:00Z`)];
  const bars = normalizeCompletedFifteenMinuteBars(raw, `${TRADING_DAY}T04:01:00Z`);
  assert.equal(bars.length, 1);
});

test("drops a duplicate timestamp (first occurrence wins)", () => {
  const raw = [candle(`${TRADING_DAY}T03:45:00Z`, { close: 100 }), candle(`${TRADING_DAY}T03:45:00Z`, { close: 999 })];
  const bars = normalizeCompletedFifteenMinuteBars(raw, `${TRADING_DAY}T23:59:00Z`);
  assert.equal(bars.length, 1);
  assert.equal(bars[0].close, 100);
});

test("drops a malformed provider bar (non-finite or non-positive OHLCV, or high < low)", () => {
  const raw = [
    candle(`${TRADING_DAY}T03:45:00Z`, { close: NaN }),
    candle(`${TRADING_DAY}T04:00:00Z`, { open: -1 }),
    candle(`${TRADING_DAY}T04:15:00Z`, { high: 90, low: 95 }),
    candle(`${TRADING_DAY}T04:30:00Z`, { volume: -5 }),
  ];
  const bars = normalizeCompletedFifteenMinuteBars(raw, `${TRADING_DAY}T23:59:00Z`);
  assert.equal(bars.length, 0);
});

test("throws on an invalid cutoff rather than silently accepting everything", () => {
  assert.throws(() => normalizeCompletedFifteenMinuteBars([candle(`${TRADING_DAY}T03:45:00Z`)], "not-a-date"));
});

test("empty input returns empty output", () => {
  assert.deepEqual(normalizeCompletedFifteenMinuteBars([], `${TRADING_DAY}T23:59:00Z`), []);
});

test("sorts output oldest-first regardless of input order", () => {
  const raw = [candle(`${TRADING_DAY}T05:00:00Z`), candle(`${TRADING_DAY}T03:45:00Z`), candle(`${TRADING_DAY}T04:00:00Z`)];
  const bars = normalizeCompletedFifteenMinuteBars(raw, `${TRADING_DAY}T23:59:00Z`);
  assert.deepEqual(
    bars.map((b) => b.ts),
    bars.map((b) => b.ts).slice().sort()
  );
});

import { test } from "node:test";
import assert from "node:assert/strict";
import { extractProvisionalFifteenMinuteCandle } from "./provisional-candle.js";

// 2026-09-17 is a Thursday, a real NSE trading day not in the holiday list.
const TRADING_DAY = "2026-09-17";

function epochAt(hh, mm) {
  return Math.floor(new Date(`${TRADING_DAY}T${String(hh).padStart(2, "0")}:${String(mm).padStart(2, "0")}:00+05:30`).getTime() / 1000);
}

test("extractProvisionalFifteenMinuteCandle: a still-forming candle is returned, marked incomplete", () => {
  const cutoff = new Date(`${TRADING_DAY}T10:05:00+05:30`); // mid-candle for the 10:00-10:15 window
  const candles = [{ ts: epochAt(10, 0), open: 100, high: 101, low: 99, close: 100.5, volume: 1000 }];
  const result = extractProvisionalFifteenMinuteCandle(candles, cutoff);
  assert.ok(result);
  assert.equal(result.isComplete, false);
});

test("extractProvisionalFifteenMinuteCandle: a fully-closed candle is not provisional (returns null)", () => {
  const cutoff = new Date(`${TRADING_DAY}T10:30:00+05:30`); // well past the 10:00-10:15 window's close
  const candles = [{ ts: epochAt(10, 0), open: 100, high: 101, low: 99, close: 100.5, volume: 1000 }];
  const result = extractProvisionalFifteenMinuteCandle(candles, cutoff);
  assert.equal(result, null);
});

test("extractProvisionalFifteenMinuteCandle: picks the LATEST still-forming candle when several are present", () => {
  const cutoff = new Date(`${TRADING_DAY}T10:20:00+05:30`);
  const candles = [
    { ts: epochAt(10, 0), open: 100, high: 101, low: 99, close: 100.5, volume: 1000 }, // closed by 10:15, excluded
    { ts: epochAt(10, 15), open: 100.5, high: 102, low: 100, close: 101, volume: 1200 }, // still forming (closes 10:30)
  ];
  const result = extractProvisionalFifteenMinuteCandle(candles, cutoff);
  assert.ok(result);
  assert.equal(new Date(result.ts).toISOString(), new Date(epochAt(10, 15) * 1000).toISOString());
});

test("extractProvisionalFifteenMinuteCandle: no candles at all returns null", () => {
  assert.equal(extractProvisionalFifteenMinuteCandle([], new Date()), null);
});

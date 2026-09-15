// NSE-session-aware normalization of raw epoch-timestamped 15-minute candles
// (providers/fyers.js's fetchFifteenMinuteOHLCV) into this project's bar
// shape -- reuses nse-calendar.js's own session/holiday/timezone
// conventions directly (NSE_TIMEZONE, SESSION_OPEN/SESSION_CLOSE,
// isNseTradingDay), the same module the main pipeline's hourly bars already
// go through (normalizeHourlyBars), rather than a separate ad hoc
// wall-clock check.
//
// Session math: NSE's cash session is exactly 09:15-15:30 IST (375 minutes),
// which divides evenly into 25 fifteen-minute windows with NO leftover stub
// -- unlike the hourly case (360 of the 375 minutes, leaving a genuine
// 15:15-15:30 stub that normalizeHourlyBars deliberately excludes). The
// final 09:15-aligned 15-minute window (15:15-15:30) is therefore a real,
// regular candle at this resolution, not a stub, and is included like any
// other of the 25 windows.

import { NSE_TIMEZONE, SESSION_OPEN, SESSION_CLOSE, isNseTradingDay } from "../nse-calendar.js";

function isoDateInZone(date, timeZone) {
  return new Intl.DateTimeFormat("en-CA", { timeZone, year: "numeric", month: "2-digit", day: "2-digit" }).format(date);
}

function timeInZone(date, timeZone) {
  return new Intl.DateTimeFormat("en-GB", { timeZone, hour: "2-digit", minute: "2-digit", hour12: false }).format(date);
}

/**
 * The 25 fifteen-minute bar windows for one NSE session (09:15-15:30 IST),
 * each [startInclusive, endExclusive) as "HH:mm" Asia/Kolkata clock strings.
 * @returns {{start: string, end: string}[]}
 */
export function fifteenMinuteBarBoundaries() {
  const bounds = [];
  let [h, m] = SESSION_OPEN.split(":").map(Number);
  const [closeH, closeM] = SESSION_CLOSE.split(":").map(Number);
  const closeMinutes = closeH * 60 + closeM;
  while (h * 60 + m < closeMinutes) {
    const start = `${String(h).padStart(2, "0")}:${String(m).padStart(2, "0")}`;
    m += 15;
    if (m >= 60) {
      m -= 60;
      h += 1;
    }
    const end = `${String(h).padStart(2, "0")}:${String(m).padStart(2, "0")}`;
    bounds.push({ start, end });
  }
  return bounds;
}

function isFiniteOhlc(candle) {
  return (
    Number.isFinite(candle.open) &&
    Number.isFinite(candle.high) &&
    Number.isFinite(candle.low) &&
    Number.isFinite(candle.close) &&
    Number.isFinite(candle.volume) &&
    candle.open > 0 &&
    candle.high > 0 &&
    candle.low > 0 &&
    candle.close > 0 &&
    candle.volume >= 0 &&
    candle.high >= candle.low
  );
}

/**
 * Converts raw epoch-timestamped 15-minute candles into this project's bar
 * shape, keeping ONLY candles that are all of:
 *   - well-formed OHLCV (finite, positive prices, high >= low, non-negative volume)
 *   - not a duplicate timestamp (first occurrence wins; later duplicates dropped)
 *   - on a real NSE trading session date (rejects weekends/holidays --
 *     `isNseTradingDay` returning null, i.e. "no holiday list for that
 *     year," is treated as NOT a trading day, never silently assumed valid)
 *   - starting at one of the 25 valid 15-minute session boundaries (rejects
 *     any pre-open/post-close or off-grid candle)
 *   - fully closed at or before `cutoff` (the run's own as_of_timestamp --
 *     this is what "excludes incomplete candles" and "never newer than the
 *     run cutoff" both reduce to: a candle's own end time must not exceed
 *     the cutoff)
 *
 * ASSUMES the provider timestamps a candle by its START time, matching this
 * project's confirmed convention for daily bars and the same
 * not-yet-independently-confirmed assumption fetchHourlyOHLCV's own callers
 * already carry for intraday resolutions (see nse-calendar.js's
 * normalizeHourlyBars comment) -- if wrong, every candle fails its boundary
 * match and this returns an empty list (NO_DATA upstream), never a wrong or
 * mislabeled bar.
 *
 * @param {{ts: number, open: number, high: number, low: number, close: number, volume: number}[]} rawCandles epoch-second timestamps, UTC
 * @param {Date|string} cutoff the run's own as_of_timestamp
 * @returns {{ts: string, date: string, sessionDate: string, open: number, high: number, low: number, close: number, volume: number, isComplete: true}[]} oldest-first
 */
export function normalizeCompletedFifteenMinuteBars(rawCandles, cutoff) {
  const cutoffDate = cutoff instanceof Date ? cutoff : new Date(cutoff);
  if (!Number.isFinite(cutoffDate.getTime())) throw new Error("normalizeCompletedFifteenMinuteBars requires a valid cutoff");

  const boundaryStarts = new Set(fifteenMinuteBarBoundaries().map((b) => b.start));
  const seenTs = new Set();
  const out = [];

  for (const candle of rawCandles ?? []) {
    if (!isFiniteOhlc(candle)) continue; // malformed provider bar

    const barStart = new Date(candle.ts * 1000);
    if (!Number.isFinite(barStart.getTime())) continue;
    const tsIso = barStart.toISOString();
    if (seenTs.has(tsIso)) continue; // duplicate provider bar -- first occurrence wins
    seenTs.add(tsIso);

    const sessionDate = isoDateInZone(barStart, NSE_TIMEZONE);
    if (isNseTradingDay(sessionDate) !== true) continue; // weekend, holiday, or unverifiable year -- never guessed valid

    const startIst = timeInZone(barStart, NSE_TIMEZONE);
    if (!boundaryStarts.has(startIst)) continue; // pre-open, post-close, or off-grid candle

    const barEnd = new Date(barStart.getTime() + 15 * 60 * 1000);
    if (barEnd.getTime() > cutoffDate.getTime()) continue; // incomplete, or would be newer than the run cutoff

    out.push({
      ts: tsIso,
      date: tsIso,
      sessionDate,
      open: candle.open,
      high: candle.high,
      low: candle.low,
      close: candle.close,
      volume: candle.volume,
      isComplete: true,
    });
  }

  return out.sort((a, b) => (a.ts < b.ts ? -1 : 1));
}

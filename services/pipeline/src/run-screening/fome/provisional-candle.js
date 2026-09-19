// Companion to buy-setup/fifteen-minute-bars.js's normalizeCompletedFifteenMinuteBars,
// which deliberately DROPS any candle whose own close time is after the run
// cutoff (never treats an incomplete candle as close-confirmed evidence).
// FOME's page additionally wants to *display* that still-forming candle,
// clearly marked PROVISIONAL, without ever feeding it into a rule or a
// Dow/indicator calculation -- this module extracts exactly that one candle,
// for display only.

import { fifteenMinuteBarBoundaries } from "../buy-setup/fifteen-minute-bars.js";
import { NSE_TIMEZONE, isNseTradingDay } from "../nse-calendar.js";

function isoDateInZone(date, timeZone) {
  return new Intl.DateTimeFormat("en-CA", { timeZone, year: "numeric", month: "2-digit", day: "2-digit" }).format(date);
}

function timeInZone(date, timeZone) {
  return new Intl.DateTimeFormat("en-GB", { timeZone, hour: "2-digit", minute: "2-digit", hour12: false }).format(date);
}

/**
 * Returns the single most recent raw candle that is on a valid 15-minute
 * session boundary, on a real trading day, but not yet fully closed as of
 * `cutoff` -- i.e. exactly the candle normalizeCompletedFifteenMinuteBars
 * would exclude. Returns null when no such candle exists (e.g. outside
 * market hours, or the feed is already fully caught up to a closed bar).
 * @param {{ts: number, open: number, high: number, low: number, close: number, volume: number}[]} rawCandles epoch-second timestamps, UTC
 * @param {Date|string} cutoff
 * @returns {{ts: string, open: number, high: number, low: number, close: number, volume: number, isComplete: false}|null}
 */
export function extractProvisionalFifteenMinuteCandle(rawCandles, cutoff) {
  const cutoffDate = cutoff instanceof Date ? cutoff : new Date(cutoff);
  if (!Number.isFinite(cutoffDate.getTime())) return null;

  const boundaryStarts = new Set(fifteenMinuteBarBoundaries().map((b) => b.start));
  let latestProvisional = null;

  for (const candle of rawCandles ?? []) {
    if (![candle.open, candle.high, candle.low, candle.close, candle.volume].every((v) => Number.isFinite(v))) continue;
    const barStart = new Date(candle.ts * 1000);
    if (!Number.isFinite(barStart.getTime())) continue;

    const sessionDate = isoDateInZone(barStart, NSE_TIMEZONE);
    if (isNseTradingDay(sessionDate) !== true) continue;

    const startIst = timeInZone(barStart, NSE_TIMEZONE);
    if (!boundaryStarts.has(startIst)) continue;

    const barEnd = new Date(barStart.getTime() + 15 * 60 * 1000);
    if (barEnd.getTime() <= cutoffDate.getTime()) continue; // already complete -- not provisional

    if (!latestProvisional || barStart.getTime() > new Date(latestProvisional.ts).getTime()) {
      latestProvisional = {
        ts: barStart.toISOString(),
        open: candle.open,
        high: candle.high,
        low: candle.low,
        close: candle.close,
        volume: candle.volume,
        isComplete: false,
      };
    }
  }

  return latestProvisional;
}

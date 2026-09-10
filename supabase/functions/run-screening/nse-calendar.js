// NSE trading-calendar utilities: Asia/Kolkata session timing, holiday
// awareness, "latest completed session" determination, and hourly bar
// boundaries. Every timestamp-sensitive piece of the pipeline (run_date,
// daily/weekly/monthly aggregation, 1-hour ingestion) should go through this
// module rather than re-deriving session logic ad hoc.
//
// Plain ESM, no framework dependency -- runs under both Node (tests) and
// Deno (the deployed Edge Function), same convention as the rest of this
// directory.

export const NSE_TIMEZONE = "Asia/Kolkata";
export const SESSION_OPEN = "09:15";
export const SESSION_CLOSE = "15:30";

// -----------------------------------------------------------------------
// Trading holidays
// -----------------------------------------------------------------------
// PROJECT_DEFAULT / secondary source, disclosed: NSE's own holiday page
// (nseindia.com/resources/exchange-communication-holidays) timed out on a
// direct fetch attempt (2026-09-10) -- consistent with this project's
// already-documented experience of nseindia.com blocking non-browser
// requests (see providers/nse-public.js's retirement note). This list was
// instead sourced from Zerodha's published holiday calendar
// (https://zerodha.com/marketintel/holiday-calendar/), retrieved 2026-09-10.
// It has NOT been cross-checked against NSE's own official circular.
// Treat as PROJECT_DEFAULT, not DOCUMENTED, until someone verifies it
// against the primary source; re-derive for each new calendar year.
//
// One entry below ("2026-01-15") looked anomalous for a national exchange
// calendar (a Maharashtra municipal-election holiday, not a typical
// NSE-wide closure) and is flagged rather than silently trusted -- if it
// turns out wrong, remove it; if right, replace this comment with the
// confirming source.
export const NSE_HOLIDAYS_2026 = [
  "2026-01-15", // UNVERIFIED -- Zerodha lists this as a Maharashtra municipal-election holiday; confirm against NSE's own circular before relying on it
  "2026-01-26", // Republic Day
  "2026-03-03", // Holi
  "2026-03-26", // Shri Ram Navami
  "2026-03-31", // Shri Mahavir Jayanti
  "2026-04-03", // Good Friday
  "2026-04-14", // Dr. Baba Saheb Ambedkar Jayanti
  "2026-05-01", // Maharashtra Day
  "2026-05-28", // Bakri Eid
  "2026-06-26", // Moharram
  "2026-09-14", // Ganesh Chaturthi
  "2026-10-02", // Mahatma Gandhi Jayanti
  "2026-10-20", // Dussehra
  "2026-11-10", // Diwali-Balipratipada (Diwali Laxmi Pujan itself, 2026-11-08, is a Sunday -- Muhurat trading, not a weekday closure)
  "2026-11-24", // Prakash Gurpurb Sri Guru Nanak Dev
  "2026-12-25", // Christmas
];

/** @returns {Set<string>} the active holiday set for the given 4-digit year, or an empty set if this module has no list for that year yet (never silently reuses a different year's list). */
function holidaySetFor(year) {
  if (year === 2026) return new Set(NSE_HOLIDAYS_2026);
  return new Set();
}

function isoDateInZone(date, timeZone) {
  return new Intl.DateTimeFormat("en-CA", { timeZone, year: "numeric", month: "2-digit", day: "2-digit" }).format(date);
}

function weekdayInZone(date, timeZone) {
  return new Intl.DateTimeFormat("en-US", { timeZone, weekday: "short" }).format(date); // "Mon".."Sun"
}

/**
 * @param {string} dateStr YYYY-MM-DD, interpreted as an Asia/Kolkata calendar date
 * @returns {boolean|null} null when this module has no holiday list for that year (never guesses)
 */
export function isNseTradingDay(dateStr) {
  const year = Number(dateStr.slice(0, 4));
  const holidays = holidaySetFor(year);
  if (holidays.size === 0 && year !== 2026) return null; // no list loaded for this year -- don't pretend to know

  const d = new Date(dateStr + "T12:00:00Z"); // noon UTC avoids DST/date-boundary edge cases entirely for a plain calendar-date weekday check
  const weekday = weekdayInZone(d, NSE_TIMEZONE);
  if (weekday === "Sat" || weekday === "Sun") return false;
  return !holidays.has(dateStr);
}

/**
 * The most recent NSE session date that has fully closed, as of `nowUtc`,
 * expressed in Asia/Kolkata. If `nowUtc` falls within today's still-open
 * session (or before it opens on a trading day), the latest *completed*
 * session is a prior trading day, not today.
 * @param {Date} nowUtc
 * @returns {string} YYYY-MM-DD
 */
export function latestCompletedNseSession(nowUtc = new Date()) {
  const todayStr = isoDateInZone(nowUtc, NSE_TIMEZONE);
  const nowIstTime = new Intl.DateTimeFormat("en-GB", {
    timeZone: NSE_TIMEZONE,
    hour: "2-digit",
    minute: "2-digit",
    hour12: false,
  }).format(nowUtc); // "HH:mm"

  const todayIsTradingDay = isNseTradingDay(todayStr);
  const pastCloseToday = nowIstTime >= SESSION_CLOSE;

  let cursor = nowUtc;
  if (todayIsTradingDay && pastCloseToday) {
    return todayStr;
  }
  // Otherwise walk backwards a day at a time until a trading day is found
  // (handles weekends, holidays, and "today hasn't closed yet" uniformly).
  for (let i = 0; i < 14; i++) {
    cursor = new Date(cursor.getTime() - 24 * 60 * 60 * 1000);
    const candidate = isoDateInZone(cursor, NSE_TIMEZONE);
    if (isNseTradingDay(candidate)) return candidate;
  }
  throw new Error(`No completed NSE trading session found within 14 days back from ${nowUtc.toISOString()}`);
}

// -----------------------------------------------------------------------
// Hourly bar boundaries
// -----------------------------------------------------------------------
// The source playbooks explicitly leave the final 15-minute session stub
// (15:15-15:30 IST) an open choice -- "merge it into the preceding candle
// or exclude it, and say which" (BUY/SELL _Weekly_Daily_1H.md, see
// docs/swing-strategy-extraction.md #10). Decision (disclosed,
// PROJECT_DEFAULT, versioned as "nse_hourly_stub_policy: exclude" v1):
// EXCLUDE it. Merging would blend a genuinely different (7.5x shorter)
// period into a real completed hour, distorting any indicator that assumes
// regular period boundaries (RSI/MACD/EMA). This mirrors the project's own
// broader rule of never treating an incomplete period as a complete one.
export const HOURLY_STUB_POLICY = "exclude";

/**
 * The 6 full-hour bar windows for one NSE session (09:15-15:15 IST), each
 * [startInclusive, endExclusive) as "HH:mm" Asia/Kolkata clock strings. The
 * trailing 15:15-15:30 stub is not included, per HOURLY_STUB_POLICY.
 * @returns {{start: string, end: string}[]}
 */
export function hourlyBarBoundaries() {
  const bounds = [];
  let [h, m] = SESSION_OPEN.split(":").map(Number);
  for (let i = 0; i < 6; i++) {
    const start = `${String(h).padStart(2, "0")}:${String(m).padStart(2, "0")}`;
    h += 1;
    const end = `${String(h).padStart(2, "0")}:${String(m).padStart(2, "0")}`;
    bounds.push({ start, end });
  }
  return bounds;
}

/**
 * True when `barCloseIstTime` ("HH:mm") is the boundary of a completed
 * hourly bar for the given session -- i.e. one of hourlyBarBoundaries()'s
 * `end` values. Used to reject a trigger from a bar that isn't actually a
 * real, completed hourly close (e.g. the excluded 15:15-15:30 stub).
 */
export function isCompletedHourlyBoundary(barCloseIstTime) {
  return hourlyBarBoundaries().some((b) => b.end === barCloseIstTime);
}

/**
 * Converts raw epoch-timestamped 1-hour candles (providers/fyers.js's
 * fetchHourlyOHLCV) into this project's bar shape, keeping only candles
 * whose IST start-of-bar clock time matches one of hourlyBarBoundaries()'s
 * 6 windows. This is what actually implements HOURLY_STUB_POLICY=exclude --
 * a candle starting at 15:15 (the trailing stub) simply doesn't match any
 * boundary and is dropped, regardless of whether the provider even returns
 * one. An off-boundary candle (a resolution/alignment artifact) is dropped
 * the same way rather than guessed into the nearest bucket.
 *
 * ASSUMES the provider timestamps an intraday candle by its START time --
 * matching this project's own confirmed convention for daily-resolution
 * candles (providers/fyers.js's fetchOHLCV maps a daily candle's timestamp
 * directly to that session's date). This has NOT been independently
 * confirmed for resolution=60 via a live response (see fetchHourlyOHLCV's
 * own comment) -- if the assumption is wrong, every candle below fails its
 * boundary match and this returns an empty list, a safe failure (no bars,
 * i.e. NO_DATA upstream) rather than a wrong or mislabeled bar.
 *
 * @param {{ts: number, open: number, high: number, low: number, close: number, volume: number}[]} rawCandles epoch-second timestamps, UTC
 * @param {Date} [nowUtc]
 * @returns {{sessionDate: string, ts: string, date: string, slotIndex: number, open: number, high: number, low: number, close: number, volume: number, isComplete: boolean}[]}
 */
export function normalizeHourlyBars(rawCandles, nowUtc = new Date()) {
  const boundaries = hourlyBarBoundaries();
  const slotIndexByStart = new Map(boundaries.map((b, i) => [b.start, i]));
  const out = [];
  for (const candle of rawCandles) {
    const barStart = new Date(candle.ts * 1000);
    const startTimeIst = new Intl.DateTimeFormat("en-GB", {
      timeZone: NSE_TIMEZONE,
      hour: "2-digit",
      minute: "2-digit",
      hour12: false,
    }).format(barStart);
    const slotIndex = slotIndexByStart.get(startTimeIst);
    if (slotIndex === undefined) continue; // the excluded 15:15-15:30 stub, or an off-boundary candle

    const barEndUtc = new Date(barStart.getTime() + 60 * 60 * 1000); // each window is a full hour by construction
    out.push({
      sessionDate: isoDateInZone(barStart, NSE_TIMEZONE),
      ts: barStart.toISOString(),
      // `date` aliases `ts` -- structure.js's zigzag/pivot/labeling functions
      // treat a bar's `date` as an opaque label (never parsed as a calendar
      // date, only used to tag a pivot), so an hourly bar is a structurally
      // valid "bar" to them as long as `date` is present and unique per bar.
      // This is what lets features/hourly-routes.js reuse that machinery
      // directly instead of re-implementing zigzag/Elliott logic for hourly
      // data.
      date: barStart.toISOString(),
      slotIndex, // 0-5, matching hourlyBarBoundaries()'s index -- the "hour slot" for hour-slot volume averaging
      open: candle.open,
      high: candle.high,
      low: candle.low,
      close: candle.close,
      volume: candle.volume,
      isComplete: barEndUtc.getTime() <= nowUtc.getTime(),
    });
  }
  return out;
}

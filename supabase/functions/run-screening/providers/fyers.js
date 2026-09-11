// Fyers data API (https://api-t1.fyers.in/data) -- a licensed broker API,
// replacing the NSE public-endpoint scraper that Supabase's egress IPs got
// 403-blocked from. Free with a Fyers trading account; see
// scripts/fyers-get-token.mjs for how the access token is produced.
//
// Auth model: FYERS_APP_ID is not sensitive on its own (an OAuth client_id
// analog -- useless without a token) and is hardcoded below. FYERS_ACCESS_TOKEN
// is a real secret that expires daily (SEBI requirement) and must be supplied
// as an Edge Function secret, refreshed manually each trading day -- this
// project deliberately does not automate Fyers login (that would require
// storing a trading PIN + TOTP secret, a much bigger credential surface).
//
// Endpoint paths and the "{appId}:{accessToken}" auth header format are
// confirmed against the official SDK source
// (github.com/skr91k/fyers_apiv3_py, fyers_apiv3/fyersModel.py) and a live
// smoke test on 2026-09-07, not just documentation.
//
// Rate limits (confirmed via a real run and Fyers' own community docs):
// 10 req/s, 200 req/min, 100k req/day -- and breaching the per-minute cap
// more than 3 times in a day gets the account blocked for the rest of the
// day, so this throttles conservatively rather than racing the limit.
// MIN_INTERVAL_MS paces every call from this module through a single
// shared cursor, regardless of caller -- but that cursor is an in-memory
// module-level variable, reset every cold isolate and invisible to any
// other concurrent invocation (problem #10, confirmed the direct cause of
// this session's incident: 5 concurrent runs each pacing independently,
// collectively exceeding the cap). It stays as a cheap first line of
// defense (avoids a DB round trip for the common single-invocation case),
// but `waitForRateLimitSlot` below -- backed by provider_rate_limit_buckets,
// migration 0007 -- is the authoritative, cross-invocation guard.
import { waitForRateLimitSlot } from "./rate-limiter.js";

const APP_ID = "5QIFNACBI4-100";
const DATA_BASE_URL = "https://api-t1.fyers.in/data";
const MIN_INTERVAL_MS = 350; // ~171 req/min, ~15% under the 200/min cap
const SHARED_RATE_LIMIT_PER_MINUTE = 180; // cross-invocation cap, same safety margin as MIN_INTERVAL_MS
const MAX_RETRIES = 2;

let nextAvailableAt = 0;

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function throttle() {
  const wait = nextAvailableAt - Date.now();
  nextAvailableAt = Math.max(Date.now(), nextAvailableAt) + MIN_INTERVAL_MS;
  if (wait > 0) await sleep(wait);
}

function authHeader() {
  const accessToken = Deno.env.get("FYERS_ACCESS_TOKEN");
  if (!accessToken) {
    throw new Error("FYERS_ACCESS_TOKEN is not set (daily token expired or never configured)");
  }
  return `${APP_ID}:${accessToken}`;
}

// Index instrumentIds (see index.js INDEX_IDS) map to Fyers' own index
// symbols -- confirmed live on 2026-09-07. Index candles report volume: 0
// (no traded volume on an index itself), which quality.js correctly treats
// as fine (0 is finite and non-negative), not a data-quality issue.
const INDEX_SYMBOL = {
  "nifty-50": "NSE:NIFTY50-INDEX",
  "nifty-bank": "NSE:NIFTYBANK-INDEX",
  "nifty-100": "NSE:NIFTY100-INDEX",
  "nifty-500": "NSE:NIFTY500-INDEX",
};

function toFyersSymbol(instrumentId, symbol) {
  return INDEX_SYMBOL[instrumentId] ?? `NSE:${symbol}-EQ`;
}

function fmtDate(d) {
  return d.toISOString().slice(0, 10);
}

/**
 * Shared request/throttle/retry loop for both fetchOHLCV (daily) and
 * fetchHourlyOHLCV -- a 429 retry policy and the cross-invocation rate-limit
 * slot are resolution-independent, no reason to duplicate them per caller.
 */
async function requestHistory(url, symbol, supabase) {
  let res, body;
  for (let attempt = 0; ; attempt++) {
    await throttle();
    if (supabase) {
      const gotSlot = await waitForRateLimitSlot(supabase, "fyers", SHARED_RATE_LIMIT_PER_MINUTE);
      if (!gotSlot) {
        throw new Error(`Fyers history request for ${symbol}: cross-invocation rate limit bucket stayed full past the wait budget`);
      }
    }
    res = await fetch(url, { headers: { Authorization: authHeader() } });
    if (res.status !== 429) break;
    if (attempt >= MAX_RETRIES) {
      throw new Error(`Fyers history request failed for ${symbol}: 429 rate-limited after ${MAX_RETRIES} retries`);
    }
    // Back off well beyond the steady-state interval -- a 429 means the
    // shared pacing wasn't enough this time (e.g. another process sharing
    // the same app), so wait longer before trying again rather than
    // hammering straight back into the limit.
    await sleep(MIN_INTERVAL_MS * 4 * (attempt + 1));
  }
  body = await res.json().catch(() => null);

  if (!res.ok || !body || body.s !== "ok") {
    throw new Error(
      `Fyers history request failed for ${symbol}: ${res.status} ${body ? JSON.stringify(body) : ""}`
    );
  }
  return body;
}

/**
 * Daily-resolution history for an explicit [fromDate, toDate] window --
 * the primitive both `fetchOHLCV` (a fixed trailing lookback, used for a
 * first-ever fetch or a full backfill leg) and the pipeline's incremental
 * fetch (only the days since the last stored bar, see `nextIncrementalRange`
 * below) are built on. `fromDate`/`toDate` are `Date` objects, inclusive.
 * @param {string} instrumentId
 * @param {string} symbol
 * @param {Date} fromDate
 * @param {Date} toDate
 * @param {import("@supabase/supabase-js").SupabaseClient} [supabase] when
 *   provided, also claims a slot in the cross-invocation rate-limit bucket
 *   before calling Fyers -- omit only for tests/local scripts that don't
 *   have a Supabase client handy; production callers must pass it.
 */
export async function fetchOHLCVRange(instrumentId, symbol, fromDate, toDate, supabase = null) {
  const url = new URL(`${DATA_BASE_URL}/history`);
  url.searchParams.set("symbol", toFyersSymbol(instrumentId, symbol));
  url.searchParams.set("resolution", "D");
  url.searchParams.set("date_format", "1");
  url.searchParams.set("range_from", fmtDate(fromDate));
  url.searchParams.set("range_to", fmtDate(toDate));
  url.searchParams.set("cont_flag", "1");

  const body = await requestHistory(url, symbol, supabase);

  const data = (body.candles ?? [])
    .map(([ts, open, high, low, close, volume]) => ({
      date: new Date(ts * 1000).toISOString().slice(0, 10),
      open: Number(open),
      high: Number(high),
      low: Number(low),
      close: Number(close),
      volume: Number(volume),
    }))
    .filter((bar) => Number.isFinite(bar.close))
    .sort((a, b) => (a.date < b.date ? -1 : 1));

  return {
    data,
    freshness: "EOD",
    provider: "fyers",
    retrievedAt: new Date().toISOString(),
  };
}

/**
 * @param {string} instrumentId
 * @param {string} symbol
 * @param {number} days
 * @param {import("@supabase/supabase-js").SupabaseClient} [supabase]
 */
export async function fetchOHLCV(instrumentId, symbol, days, supabase = null) {
  const to = new Date();
  const from = new Date(to.getTime() - days * 24 * 60 * 60 * 1000);
  return fetchOHLCVRange(instrumentId, symbol, from, to, supabase);
}

/**
 * Pure date-range decision for the pipeline's incremental daily fetch
 * (index.ts's processIncrementalBatch): fetch only what's missing since the
 * last stored bar, instead of always re-fetching the full lookback window
 * every run. Returns `null` when there is nothing new to fetch (the latest
 * stored session is already the target run date or later -- e.g. a retry
 * of an already-processed instrument).
 * @param {string|null} latestStoredSessionDate 'YYYY-MM-DD', or null if no bar has ever been stored for this instrument
 * @param {string} runDate 'YYYY-MM-DD' -- the target session (latestCompletedNseSession())
 * @param {number} fallbackLookbackDays used verbatim when latestStoredSessionDate is null (first-ever fetch)
 * @returns {{from: Date, to: Date}|null}
 */
export function nextIncrementalRange(latestStoredSessionDate, runDate, fallbackLookbackDays) {
  const to = new Date(`${runDate}T00:00:00Z`);
  if (!latestStoredSessionDate) {
    const from = new Date(to.getTime() - fallbackLookbackDays * 24 * 60 * 60 * 1000);
    return { from, to };
  }
  const latest = new Date(`${latestStoredSessionDate}T00:00:00Z`);
  const from = new Date(latest.getTime() + 24 * 60 * 60 * 1000);
  if (from.getTime() > to.getTime()) return null; // already up to date
  return { from, to };
}

// The swing playbooks only ever reason about a handful of the most recent
// hourly candles (BUY-3/SELL-2's own documented structural minimum is
// "fifteen to twenty hourly candles" -- see swing-strategy-extraction.md
// §2, BUY-3), not a long history -- unlike daily bars (which need ~250
// trading days for EMA-200/MACD warmup), 1-hour ingestion only needs a
// short, recent window.
//
// Revised from 15 to 30 calendar days once BUY-1/SELL-3's hour-slot volume
// check was implemented (features/hourly-routes.js): that check needs
// `hour_slot_volume_lookback_sessions` (15, config/parameters.yaml) PRIOR
// trading sessions of the SAME hour-of-day, i.e. at least ~16 trading
// sessions of history before today's own session. 30 calendar days is
// roughly 20-21 NSE trading days -- comfortable margin over that 16-session
// floor (and still well over the 15-20 hourly-candle pivot-finding floor),
// while staying far under any plausible Fyers intraday date-range cap so
// this doesn't depend on knowing that cap's exact value (unlike
// OHLCV_LOOKBACK_DAYS's 366-day daily-resolution cap, index.js's own
// comment, this has NOT been confirmed via a live response -- no
// FYERS_ACCESS_TOKEN is available in this environment). PROJECT_DEFAULT,
// versioned here.
const HOURLY_LOOKBACK_DAYS = 30;

/**
 * Fetches the trailing HOURLY_LOOKBACK_DAYS of 1-hour candles. Returns raw
 * epoch-timestamped bars -- callers should run these through
 * nse-calendar.js's normalizeHourlyBars() before storage, which excludes
 * the trailing 15-minute session stub and marks the still-forming current
 * hour as incomplete.
 *
 * date_format=0 (epoch-second range bounds, not date-only strings) is used
 * here instead of fetchOHLCV's date_format=1 -- an intraday resolution needs
 * a boundary finer than a calendar day. This parameter choice follows
 * Fyers' documented history API shape but, like the resolution="60" value
 * itself, has not been independently confirmed against a live response in
 * this environment (no FYERS_ACCESS_TOKEN available) -- verify empirically
 * once a token is configured, before relying on this in production.
 *
 * @param {string} instrumentId
 * @param {string} symbol
 * @param {import("@supabase/supabase-js").SupabaseClient} [supabase]
 * @param {number} [days]
 */
export async function fetchHourlyOHLCV(instrumentId, symbol, supabase = null, days = HOURLY_LOOKBACK_DAYS) {
  const to = new Date();
  const from = new Date(to.getTime() - days * 24 * 60 * 60 * 1000);

  const url = new URL(`${DATA_BASE_URL}/history`);
  url.searchParams.set("symbol", toFyersSymbol(instrumentId, symbol));
  url.searchParams.set("resolution", "60");
  url.searchParams.set("date_format", "0");
  url.searchParams.set("range_from", String(Math.floor(from.getTime() / 1000)));
  url.searchParams.set("range_to", String(Math.floor(to.getTime() / 1000)));
  url.searchParams.set("cont_flag", "1");

  const body = await requestHistory(url, symbol, supabase);

  const data = (body.candles ?? [])
    .map(([ts, open, high, low, close, volume]) => ({
      ts: Number(ts), // epoch seconds, UTC
      open: Number(open),
      high: Number(high),
      low: Number(low),
      close: Number(close),
      volume: Number(volume),
    }))
    .filter((bar) => Number.isFinite(bar.close))
    .sort((a, b) => a.ts - b.ts);

  return {
    data,
    freshness: "INTRADAY",
    provider: "fyers",
    retrievedAt: new Date().toISOString(),
  };
}

export { HOURLY_LOOKBACK_DAYS };

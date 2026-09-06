// Unofficial NSE public-website adapter -- MVP bridge only, per
// references/market-data-policy.md ("official/licensed sources" is the
// documented preference; this exists so the platform has real data to work
// with before that account is set up). Every record this returns is tagged
// PROVIDER_ID.NSE_PUBLIC_UNOFFICIAL and a freshness of EOD/DELAYED, never
// LIVE -- callers must not relabel it.
//
// NSE's website blocks requests that don't look like a browser: it requires
// a same-session cookie obtained by first loading the homepage, plus
// browser-shaped headers on every subsequent call. There is no publish SLA
// or documented schema version for these endpoints -- they can change or
// start blocking a given IP/host without notice, which is exactly the
// reliability gap a licensed provider is meant to close later.

import { PROVIDER_ID } from "./types.js";

const BASE_URL = "https://www.nseindia.com";
const BROWSER_HEADERS = {
  "User-Agent":
    "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36",
  Accept: "application/json, text/plain, */*",
  "Accept-Language": "en-US,en;q=0.9",
  Referer: `${BASE_URL}/`,
};

const INDEX_QUERY_NAME = {
  "nifty-50": "NIFTY 50",
  "nifty-bank": "NIFTY BANK",
  "nifty-100": "NIFTY 100",
  "nifty-500": "NIFTY 500",
};

async function primeSession() {
  const res = await fetch(BASE_URL, { headers: BROWSER_HEADERS });
  const cookie = res.headers.get("set-cookie");
  if (!res.ok || !cookie) {
    throw new Error(`Failed to prime NSE session (status ${res.status})`);
  }
  // Deno/undici collapse multiple Set-Cookie headers into one string joined
  // by ", " in some runtimes; NSE only needs the name=value pairs, not the
  // attributes, so split defensively on both patterns.
  return cookie
    .split(/,(?=[^;]+?=)/)
    .map((c) => c.split(";")[0].trim())
    .join("; ");
}

async function fetchJson(path, cookie) {
  const res = await fetch(`${BASE_URL}${path}`, {
    headers: { ...BROWSER_HEADERS, Cookie: cookie },
  });
  if (!res.ok) {
    throw new Error(`NSE request failed: ${path} -> ${res.status}`);
  }
  return res.json();
}

function toIsoDate(ddMmYyyy) {
  // NSE date format is "DD-Mon-YYYY" (e.g. "05-Sep-2026") depending on endpoint;
  // callers pass through whatever the API returns and this only normalizes
  // the common "DD-MM-YYYY" numeric form used by the historical endpoint.
  const parts = ddMmYyyy.split("-");
  if (parts.length === 3 && /^\d+$/.test(parts[1])) {
    const [dd, mm, yyyy] = parts;
    return `${yyyy}-${mm.padStart(2, "0")}-${dd.padStart(2, "0")}`;
  }
  return ddMmYyyy;
}

/** @type {import("./types.js").MarketDataProvider} */
export const nsePublicProvider = {
  async getIndexConstituents(indexId) {
    const queryName = INDEX_QUERY_NAME[indexId];
    if (!queryName) throw new Error(`Unknown index id: ${indexId}`);

    const cookie = await primeSession();
    const json = await fetchJson(`/api/equity-stockIndices?index=${encodeURIComponent(queryName)}`, cookie);

    const data = (json.data ?? [])
      .filter((row) => row.symbol && row.symbol !== queryName) // NSE includes the index row itself
      .map((row) => ({
        instrumentId: `NSE_${row.symbol}`,
        symbol: row.symbol,
        name: row.meta?.companyName ?? row.symbol,
      }));

    return {
      data,
      freshness: "EOD",
      provider: PROVIDER_ID.NSE_PUBLIC_UNOFFICIAL,
      retrievedAt: new Date().toISOString(),
    };
  },

  async getOHLCV(instrumentId, symbol, days) {
    const cookie = await primeSession();
    const to = new Date();
    const from = new Date(to.getTime() - days * 24 * 60 * 60 * 1000);
    const fmt = (d) =>
      `${String(d.getDate()).padStart(2, "0")}-${String(d.getMonth() + 1).padStart(2, "0")}-${d.getFullYear()}`;

    const json = await fetchJson(
      `/api/historical/cm/equity?symbol=${encodeURIComponent(symbol)}&series=["EQ"]&from=${fmt(from)}&to=${fmt(to)}`,
      cookie
    );

    const data = (json.data ?? [])
      .map((row) => ({
        date: toIsoDate(row.CH_TIMESTAMP ?? row.mTIMESTAMP ?? ""),
        open: Number(row.CH_OPENING_PRICE),
        high: Number(row.CH_TRADE_HIGH_PRICE),
        low: Number(row.CH_TRADE_LOW_PRICE),
        close: Number(row.CH_CLOSING_PRICE),
        volume: Number(row.CH_TOT_TRADED_QTY),
      }))
      .filter((bar) => bar.date && Number.isFinite(bar.close))
      .sort((a, b) => (a.date < b.date ? -1 : 1));

    return {
      data,
      freshness: "EOD",
      provider: PROVIDER_ID.NSE_PUBLIC_UNOFFICIAL,
      retrievedAt: new Date().toISOString(),
    };
  },

  async getCorporateActions(instrumentId, symbol) {
    const cookie = await primeSession();
    const json = await fetchJson(
      `/api/corporates-corporateActions?index=equities&symbol=${encodeURIComponent(symbol)}`,
      cookie
    );

    const data = (Array.isArray(json) ? json : []).map((row) => ({
      actionType: row.subject ?? row.purpose ?? "unknown",
      exDate: row.exDate ? toIsoDate(row.exDate) : null,
      raw: row,
    }));

    return {
      data,
      freshness: "EOD",
      provider: PROVIDER_ID.NSE_PUBLIC_UNOFFICIAL,
      retrievedAt: new Date().toISOString(),
    };
  },
};

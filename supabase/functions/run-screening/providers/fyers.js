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

const APP_ID = "5QIFNACBI4-100";
const DATA_BASE_URL = "https://api-t1.fyers.in/data";

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

export async function fetchOHLCV(instrumentId, symbol, days) {
  const to = new Date();
  const from = new Date(to.getTime() - days * 24 * 60 * 60 * 1000);

  const url = new URL(`${DATA_BASE_URL}/history`);
  url.searchParams.set("symbol", toFyersSymbol(instrumentId, symbol));
  url.searchParams.set("resolution", "D");
  url.searchParams.set("date_format", "1");
  url.searchParams.set("range_from", fmtDate(from));
  url.searchParams.set("range_to", fmtDate(to));
  url.searchParams.set("cont_flag", "1");

  const res = await fetch(url, { headers: { Authorization: authHeader() } });
  const body = await res.json().catch(() => null);

  if (!res.ok || !body || body.s !== "ok") {
    throw new Error(
      `Fyers history request failed for ${symbol}: ${res.status} ${body ? JSON.stringify(body) : ""}`
    );
  }

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

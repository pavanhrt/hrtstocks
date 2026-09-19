// Fyers derivative-data endpoints (option chain, futures chain, market
// depth/OI) -- extends providers/fyers.js's already-confirmed auth model and
// base URL rather than duplicating it. Endpoint paths, query parameters, and
// response field names below are confirmed against Fyers' official API
// documentation (myapi.fyers.in/docsv3, "Data Api" > Option Chain / Futures
// Chain / Market Depth sections) -- NOT live-tested in this environment
// until a real analysis run exercises it. Verify empirically against a live
// response, same disclosure convention fyers.js's own fetchHourlyOHLCV/
// fetchFifteenMinuteOHLCV already use for their own not-yet-independently-
// confirmed resolution parameters.
//
// Per Phase 9 of this feature's own scope (references/market-data-policy.md's
// source priority): Fyers is a LICENSED BROKER source (priority tier 2), not
// the official NSE contract/security master (tier 1) -- this project has no
// NSE contract-master ingestion (nseindia.com blocks non-browser requests,
// confirmed elsewhere in this codebase's own provider history). Contract
// eligibility/expiry/strike/premium/OI/IV read from these endpoints are
// disclosed as broker-sourced, not exchange-authoritative. Lot size is NOT
// returned by ANY endpoint below (confirmed against the documented response
// attributes of all three) -- fome/contract-selection.js and
// fome/strategy-comparison.js both treat a missing lot size as `null`,
// never invented, per AGENTS.md's rule against fabricating contract
// metadata.
//
// Confirmed request/response shapes:
//   GET /data/options-chain-v3?symbol=<sym>&strikecount=<n>
//     -> { data: { callOi, putOi, expiryData: [{date, expiry, expiry_flag}],
//                  optionsChain: [{ symbol, strike_price, option_type ("CE"|"PE"|""),
//                    ltp, ltpch, ltpchp, bid, ask, oi, oich, oichp, prev_oi,
//                    volume, fp, fpch, fpchp, description, ex_symbol, exchange,
//                    fytoken, delta, gamma, theta, vega, iv }] } }
//     The underlying's own row has option_type: "" (empty) -- not a contract.
//     No lot_size field anywhere in this response.
//   GET /data/futures-chain?symbol=<sym>
//     -> { data: [{ symbol, fyToken, lp, ch, chp, expiry, volume }] } -- the
//     underlying's own row has expiry: "" (empty); no OI field either.
//   GET /data/depth?symbol=<sym>&ohlcv_flag=1  (single symbol only)
//     -> { d: { <symbol>: { oi, oiflag, pdoi, oipercent, o,h,l,c,v, ... } } }
//     the top-level key layout is not independently confirmed in this
//     environment; this module always requests exactly one symbol and reads
//     whichever single value the response object contains, tolerant of
//     either a `{d: {<symbol>: {...}}}` or a flat `{...}` shape.
import { waitForRateLimitSlot } from "./rate-limiter.js";
import { serializeFyersRequest } from "./fyers.js";
import { assertNotAuthFailure, fyersAuthHeader } from "./fyers-credentials.js";

const DATA_BASE_URL = "https://api-t1.fyers.in/data";
const SHARED_RATE_LIMIT_PER_MINUTE = 180;

const authHeader = fyersAuthHeader;

async function requestJson(url, db) {
  return serializeFyersRequest(async () => {
    if (db) {
      const gotSlot = await waitForRateLimitSlot(db, "fyers", SHARED_RATE_LIMIT_PER_MINUTE);
      if (!gotSlot) {
        throw new Error(`Fyers derivative request timed out waiting for a rate-limit slot: ${url}`);
      }
    }
    const res = await fetch(url, { headers: { Authorization: authHeader() } });
    const body = await res.json().catch(() => null);
    if (!res.ok || !body || body.s === "error") {
      assertNotAuthFailure(res.status, body);
      throw new Error(`Fyers derivative request failed: ${res.status} ${body ? JSON.stringify(body) : ""}`);
    }
    return body;
  });
}

/**
 * @param {string} underlyingSymbol Fyers symbol, e.g. "NSE:RELIANCE-EQ" or "NSE:NIFTY50-INDEX"
 * @param {number} strikeCount ATM +/- this many strikes each side (max 50 per Fyers docs)
 * @param {import("../../db/client.js").Db} [db]
 */
export async function fetchOptionChain(underlyingSymbol, strikeCount, db = null) {
  const url = new URL(`${DATA_BASE_URL}/options-chain-v3`);
  url.searchParams.set("symbol", underlyingSymbol);
  url.searchParams.set("strikecount", String(strikeCount));

  const body = await requestJson(url, db);
  const data = body.data ?? {};
  const chain = (data.optionsChain ?? []).filter((row) => row.option_type === "CE" || row.option_type === "PE");

  return {
    underlyingSymbol,
    callOi: numOrNull(data.callOi),
    putOi: numOrNull(data.putOi),
    expiries: (data.expiryData ?? []).map((e) => ({ date: e.date, expiryEpoch: e.expiry, flag: e.expiry_flag })),
    contracts: chain.map((row) => ({
      symbol: row.symbol,
      optionType: row.option_type,
      strike: Number(row.strike_price),
      ltp: numOrNull(row.ltp),
      ltpChange: numOrNull(row.ltpch),
      ltpChangePct: numOrNull(row.ltpchp),
      bid: numOrNull(row.bid),
      ask: numOrNull(row.ask),
      oi: numOrNull(row.oi),
      oiChange: numOrNull(row.oich),
      oiChangePct: numOrNull(row.oichp),
      previousOi: numOrNull(row.prev_oi),
      volume: numOrNull(row.volume),
      iv: numOrNull(row.iv),
      delta: numOrNull(row.delta),
      description: row.description ?? null,
      fyToken: row.fytoken ?? null,
    })),
    freshness: "LIVE",
    provider: "fyers",
    retrievedAt: new Date().toISOString(),
  };
}

/**
 * @param {string} underlyingSymbol
 * @param {import("../../db/client.js").Db} [db]
 */
export async function fetchFuturesChain(underlyingSymbol, db = null) {
  const url = new URL(`${DATA_BASE_URL}/futures-chain`);
  url.searchParams.set("symbol", underlyingSymbol);

  const body = await requestJson(url, db);
  const rows = (body.data ?? []).filter((row) => row.expiry); // the underlying's own row has empty expiry

  return {
    underlyingSymbol,
    contracts: rows.map((row) => ({
      symbol: row.symbol,
      lastPrice: numOrNull(row.lp),
      change: numOrNull(row.ch),
      changePct: numOrNull(row.chp),
      expiryEpoch: row.expiry,
      volume: numOrNull(row.volume),
      fyToken: row.fyToken ?? null,
    })),
    freshness: "LIVE",
    provider: "fyers",
    retrievedAt: new Date().toISOString(),
  };
}

/**
 * Single-symbol market depth -- the only Fyers endpoint that carries a
 * futures/option contract's own open interest. Fyers documents a max of 1
 * symbol per call.
 * @param {string} symbol
 * @param {import("../../db/client.js").Db} [db]
 */
export async function fetchMarketDepth(symbol, db = null) {
  const url = new URL(`${DATA_BASE_URL}/depth`);
  url.searchParams.set("symbol", symbol);
  url.searchParams.set("ohlcv_flag", "1");

  const body = await requestJson(url, db);
  const row = body.d?.[symbol] ?? body.d ?? body.data ?? body;

  return {
    symbol,
    oi: numOrNull(row?.oi),
    previousOi: numOrNull(row?.pdoi),
    oiChangePct: numOrNull(row?.oipercent),
    lastPrice: numOrNull(row?.ltp ?? row?.lp),
    changePct: numOrNull(row?.chp),
    freshness: "LIVE",
    provider: "fyers",
    retrievedAt: new Date().toISOString(),
  };
}

function numOrNull(value) {
  const n = Number(value);
  return Number.isFinite(n) ? n : null;
}

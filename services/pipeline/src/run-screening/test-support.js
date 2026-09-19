// Fake external providers for pipeline tests: NSE archive CSVs and FYERS history. Only these two network
// dependencies are faked; everything else in a run is real.
export const STOCKS = { AAA: 0.3, BBB: 0.15, CCC: -0.15, DDD: 0.0, EEE: 0.4 }; // symbol -> daily drift
const EPOCH_DAY_ORIGIN = 19_875; // 2024-06-01: keeps every synthetic price positive
export const CSV = `Company Name,Industry,Symbol,Series,ISIN Code\n${Object.keys(STOCKS).map((s) => `${s} Ltd,Test,${s},EQ,INE${s}0000000`).join("\n")}\n`;

export function priceOf(symbol, dayIndex) {
  const drift = STOCKS[symbol] ?? 0.2;
  return 300 + drift * dayIndex + 7 * Math.sin(dayIndex / 6) + (symbol.length % 3);
}

export const toUrl = (input) => (input instanceof URL ? input : new URL(typeof input === "string" ? input : input.url));

/**
 * @param {string[]} calls collects the hostnames contacted
 * @param {{ failSymbols?: Set<string>, nseStatus?: number }} [opts] injected outages: FYERS 500 for the listed symbols, NSE archive HTTP status
 */
export function fakeFetch(calls, { failSymbols = new Set(), nseStatus = 200 } = {}) {
  return async (input) => {
    const url = toUrl(input);
    calls.push(url.hostname);
    if (url.hostname === "nsearchives.nseindia.com") return nseStatus === 200 ? new Response(CSV, { status: 200 }) : new Response("upstream error", { status: nseStatus });
    if (url.hostname !== "api-t1.fyers.in") throw new Error(`unexpected network call to ${url.hostname}`);

    const symbol = (url.searchParams.get("symbol") ?? "").replace(/^NSE:/, "").replace(/-EQ$|-INDEX$/, "");
    if (failSymbols.has(symbol)) return new Response(JSON.stringify({ s: "error", code: 500, message: "provider unavailable" }), { status: 500 });
    const resolution = url.searchParams.get("resolution");
    const candles = [];
    if (resolution === "D") {
      const from = new Date(`${url.searchParams.get("range_from")}T00:00:00Z`);
      const to = new Date(`${url.searchParams.get("range_to")}T00:00:00Z`);
      for (let d = from; d <= to; d = new Date(d.getTime() + 86_400_000)) {
        if (d.getUTCDay() === 0 || d.getUTCDay() === 6) continue;
        const i = Math.floor(d.getTime() / 86_400_000) - EPOCH_DAY_ORIGIN;
        const c = priceOf(symbol, i);
        candles.push([d.getTime() / 1000, c - 0.4, c + 1.2, c - 1.2, c, 1_000_000 + (i % 9) * 5_000]);
      }
    } else {
      const from = Number(url.searchParams.get("range_from"));
      const to = Number(url.searchParams.get("range_to"));
      for (let day = Math.floor(from / 86_400) * 86_400; day <= to; day += 86_400) {
        const dow = new Date(day * 1000).getUTCDay();
        if (dow === 0 || dow === 6) continue;
        const i = Math.floor(day / 86_400) - EPOCH_DAY_ORIGIN;
        for (let h = 0; h < 6; h++) {
          const ts = day + (3 * 3600 + 45 * 60) + h * 3600; // 09:15 IST + h hours
          if (ts < from || ts > to) continue;
          const c = priceOf(symbol, i) + Math.sin(h) * 0.6;
          candles.push([ts, c - 0.2, c + 0.5, c - 0.5, c, 100_000]);
        }
      }
    }
    return new Response(JSON.stringify({ s: "ok", candles }), { status: 200, headers: { "content-type": "application/json" } });
  };
}


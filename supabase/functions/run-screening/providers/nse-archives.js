// Index constituent lists from NSE's static archive/CDN domain
// (nsearchives.nseindia.com), not the interactive www.nseindia.com API that
// blocks cloud/datacenter egress IPs with a 403 (see nse-public.js, now
// retired from the pipeline for that reason). This is a plain CSV file
// download, no session cookie or browser-shaped headers required -- verified
// reachable and current as of 2026-09-07.
//
// This does NOT solve OHLCV ingestion (that's providers/fyers.js) -- it only
// answers "which stocks are in this index right now," which no broker API
// provides.

const INDEX_CSV_URL = {
  "nifty-50": "https://nsearchives.nseindia.com/content/indices/ind_nifty50list.csv",
  "nifty-bank": "https://nsearchives.nseindia.com/content/indices/ind_niftybanklist.csv",
  "nifty-100": "https://nsearchives.nseindia.com/content/indices/ind_nifty100list.csv",
  "nifty-500": "https://nsearchives.nseindia.com/content/indices/ind_nifty500list.csv",
};

/** Minimal CSV line split -- NSE's index files are plain comma-separated with no embedded commas or quoting in practice. */
function parseCsvLine(line) {
  return line.split(",").map((cell) => cell.trim());
}

export async function fetchIndexConstituents(indexId) {
  const url = INDEX_CSV_URL[indexId];
  if (!url) throw new Error(`Unknown index id: ${indexId}`);

  const res = await fetch(url, { headers: { "User-Agent": "Mozilla/5.0" } });
  if (!res.ok) throw new Error(`NSE archive request failed: ${url} -> ${res.status}`);

  const text = await res.text();
  const lines = text.split(/\r?\n/).filter((l) => l.trim().length > 0);
  const header = parseCsvLine(lines[0]).map((h) => h.toLowerCase());
  const symbolIdx = header.indexOf("symbol");
  const nameIdx = header.indexOf("company name");
  if (symbolIdx === -1) throw new Error(`Unexpected CSV header for ${indexId}: ${lines[0]}`);

  const data = lines.slice(1).map((line) => {
    const cells = parseCsvLine(line);
    const symbol = cells[symbolIdx];
    return {
      instrumentId: `NSE_${symbol}`,
      symbol,
      name: nameIdx !== -1 ? cells[nameIdx] : symbol,
    };
  });

  return {
    data,
    freshness: "EOD",
    provider: "nse_archives",
    retrievedAt: new Date().toISOString(),
  };
}

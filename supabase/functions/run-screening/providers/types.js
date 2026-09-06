// The MarketDataProvider contract every ingestion adapter must satisfy.
// nse-public.js is the only implementation today (unofficial, free, MVP-only
// per references/market-data-policy.md); a future licensed provider drops in
// behind this same shape without touching the orchestrator, feature engine,
// or rule engine.
//
// Every method returns `{ data, freshness, provider, retrievedAt }` on
// success so callers can persist provenance alongside the values, or throws
// on hard failure -- callers must quarantine, never fabricate a substitute.

/**
 * @typedef {Object} Bar
 * @property {string} date - YYYY-MM-DD, exchange calendar date
 * @property {number} open
 * @property {number} high
 * @property {number} low
 * @property {number} close
 * @property {number} volume
 */

/**
 * @typedef {Object} MarketDataProvider
 * @property {(indexId: string) => Promise<{data: {instrumentId: string, symbol: string, name: string}[], freshness: string, provider: string, retrievedAt: string}>} getIndexConstituents
 * @property {(instrumentId: string, symbol: string, days: number) => Promise<{data: Bar[], freshness: string, provider: string, retrievedAt: string}>} getOHLCV
 * @property {(instrumentId: string, symbol: string) => Promise<{data: object[], freshness: string, provider: string, retrievedAt: string}>} getCorporateActions
 */

export const PROVIDER_ID = {
  NSE_PUBLIC_UNOFFICIAL: "nse_public_unofficial",
};

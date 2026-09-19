// The one authoritative price series consumed by feature/rule/chart code.
// FYERS Support Desk confirms that History API prices and volumes are already
// corporate-action adjusted. We therefore preserve the provider values and
// explicitly record that state instead of applying the local split/bonus
// back-adjuster a second time.

export const ANALYSIS_SERIES_VERSION = "fyers-history-provider-adjusted-v1";
export const FYERS_ADJUSTMENT_STATE = "provider_adjusted";
export const FYERS_ADJUSTMENT_PROVENANCE = {
  provider: "fyers",
  claim: "History API price and volume are corporate-action adjusted",
  verifiedAt: "2026-09-12",
  sources: [
    "https://fyers.in/community/t/are-stocks-price-and-volume-adjusted-for-corp-actions-like-splits-bonuses-dividends-etc-in-daily-and-1-min-timeframe-sourced-via-historical-api/22387",
    "https://fyers.in/community/t/how-do-we-adjust-historical-prices-downloaded-and-saved-on-our-local-system-through-the-fyers-api-based-on-corporate-actions/22441",
  ],
};

/**
 * @param {object} input
 * @param {object[]} input.bars
 * @param {string} input.provider
 * @param {string} input.interval
 * @param {string} input.asOfTimestamp
 * @returns {{bars: object[], provider: string, interval: string, adjustmentState: string,
 *   algorithmVersion: string, provenance: object, asOfTimestamp: string}}
 */
export function buildAnalysisBars({ bars, provider, interval, asOfTimestamp }) {
  if (provider !== "fyers") {
    throw new Error(`No verified adjustment policy exists for provider ${provider}`);
  }
  if (!asOfTimestamp || !Number.isFinite(Date.parse(asOfTimestamp))) {
    throw new Error("A valid immutable asOfTimestamp is required for analysisBars");
  }
  return {
    bars: (bars ?? []).map((bar) => ({ ...bar })),
    provider,
    interval,
    adjustmentState: FYERS_ADJUSTMENT_STATE,
    algorithmVersion: ANALYSIS_SERIES_VERSION,
    provenance: FYERS_ADJUSTMENT_PROVENANCE,
    asOfTimestamp,
  };
}

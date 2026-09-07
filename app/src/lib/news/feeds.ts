// Free, publicly syndicated RSS feeds -- no API key, no ToS gray area (RSS is
// explicitly meant for redistribution), unlike the NSE/investing.com scraping
// situation. Verified live and updating (not stale/abandoned) as of
// 2026-09-07 -- Moneycontrol's RSS feeds were checked and found dead
// (serving cached content from 2024), which is why they're not listed here.
// Re-verify freshness (lastBuildDate near "now") before adding a new one.
export const NEWS_FEEDS = [
  { source: "Economic Times Markets", url: "https://economictimes.indiatimes.com/markets/rssfeeds/1977021501.cms" },
  { source: "Business Standard Markets", url: "https://www.business-standard.com/rss/markets-106.rss" },
  { source: "LiveMint Markets", url: "https://www.livemint.com/rss/markets" },
] as const;

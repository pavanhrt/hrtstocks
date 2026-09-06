// Data-quality checks from references/market-data-policy.md. Only PASS may
// satisfy a hard freshness gate -- everything else quarantines the
// instrument's bars rather than silently dropping or repairing them.

/**
 * @param {import("./providers/types.js").Bar[]} bars - oldest-first
 * @param {{ staleDays?: number }} [options]
 * @returns {{ result: "PASS"|"PARTIAL"|"INVALID"|"NO_DATA", issues: string[] }}
 */
export function validateBars(bars, { staleDays = 5 } = {}) {
  if (!bars || bars.length === 0) {
    return { result: "NO_DATA", issues: ["no bars returned"] };
  }

  const issues = [];
  // Critical issues mean the bar's price shape itself is unusable. Volume and
  // staleness issues are real quality problems worth surfacing, but they
  // don't on their own make the bar's price data unusable the way a
  // negative/zero price or an inverted high/low does.
  let criticalCount = 0;

  for (const bar of bars) {
    if (![bar.open, bar.high, bar.low, bar.close].every((v) => Number.isFinite(v) && v > 0)) {
      issues.push(`${bar.date}: missing or non-positive OHLC`);
      criticalCount++;
      continue;
    }
    if (bar.high < bar.low) {
      issues.push(`${bar.date}: high below low`);
      criticalCount++;
      continue;
    }
    if (bar.close > bar.high || bar.close < bar.low) {
      issues.push(`${bar.date}: close outside high-low range`);
      criticalCount++;
      continue;
    }
    if (!Number.isFinite(bar.volume) || bar.volume < 0) {
      issues.push(`${bar.date}: negative or missing volume`);
    }
  }

  const latest = bars[bars.length - 1];
  const ageDays = (Date.now() - new Date(latest.date).getTime()) / (24 * 60 * 60 * 1000);
  if (ageDays > staleDays) {
    issues.push(`latest bar ${latest.date} is ${Math.floor(ageDays)} days old (stale threshold ${staleDays})`);
  }

  if (criticalCount === bars.length) return { result: "INVALID", issues };
  if (issues.length > 0) return { result: "PARTIAL", issues };
  return { result: "PASS", issues: [] };
}

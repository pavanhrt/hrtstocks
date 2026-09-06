// Coverage reconciliation per shared-gates.yaml:
//   unique_stock_count == tier_a + tier_b + watch + manual_review + rejected + unavailable
// and AGENTS.md's output contract: "The run is incomplete unless" that holds.
// publish_when_false is documented as false, so index.js must not mark a run
// `completed` when this doesn't reconcile.

/**
 * @param {{ tier: string }[]} stockResults - instrument_run_results rows for
 *   non-index instruments only (indexes are contextual, never counted here)
 */
export function reconcileCoverage(stockResults) {
  const counts = {
    tier_a: 0,
    tier_b: 0,
    watch: 0,
    manual_review: 0,
    rejected: 0,
    unavailable: 0,
  };

  for (const r of stockResults) {
    if (r.tier in counts) counts[r.tier]++;
  }

  const summed = Object.values(counts).reduce((a, b) => a + b, 0);
  const uniqueStockCount = stockResults.length;

  return {
    unique_stock_count: uniqueStockCount,
    tier_a: counts.tier_a,
    tier_b: counts.tier_b,
    watch: counts.watch,
    manual_review: counts.manual_review,
    rejected: counts.rejected,
    unavailable: counts.unavailable,
    reconciled: summed === uniqueStockCount,
  };
}

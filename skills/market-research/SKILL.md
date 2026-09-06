---
name: market-research
description: Assemble and validate current Indian equity, index, futures, and options data for reproducible research snapshots. Use before current NIFTY index or constituent analysis; do not label data live without verified provider timestamps.
---

# Market Research

## Outcome

Produce one coherent, timestamped, quality-checked data snapshot suitable for deterministic screening.

Read [../../AGENTS.md](../../AGENTS.md), [../../references/market-data-policy.md](../../references/market-data-policy.md), and [../../config/universe.yaml](../../config/universe.yaml).

## Workflow

1. Determine `EOD` or explicitly requested `INTRADAY` mode and the latest completed bar.
2. Verify exchange session and holiday status.
3. Refresh current membership for all configured indexes with effective dates.
4. Deduplicate constituents by stable instrument identifier while preserving membership tags.
5. Obtain index and stock OHLCV, corporate actions, and liquidity inputs.
6. If required, obtain current derivative eligibility, contract master, futures, options, lot sizes, expiries, and margins.
7. Align timestamps and normalize identifiers.
8. Run field, calendar, corporate-action, freshness, and cross-market validation.
9. Assign a data-quality state to every instrument; never silently drop a failed record.
10. Freeze the snapshot and return its ID, coverage, timestamps, and limitations.

## Required outputs

- Provider and retrieval metadata
- Data mode and freshness label
- Latest completed session/bar
- Index membership counts and deduplicated total
- Instrument mapping and membership tags
- Valid/partial/stale/invalid/no-data counts
- Per-instrument quality result and primary issue
- Frozen snapshot identifier

## Stop conditions

Do not publish a complete current scan if index membership is unverified, timestamp meaning is unknown, required bars are stale, or coverage reconciliation fails. A partial diagnostic snapshot may still be returned with explicit limitations.

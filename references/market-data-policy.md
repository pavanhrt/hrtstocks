# Market Data Policy

## Source priority

1. Official NSE/Nifty Indices publications and contract masters
2. Licensed exchange-authorized market-data or broker feeds
3. Reputable secondary sources for non-authoritative cross-checks

Never scrape or redistribute data contrary to access terms or licenses.

## Required datasets

- Current index constituents and effective dates
- Stable instrument identifiers and symbol history
- Adjusted and unadjusted daily/weekly OHLCV
- Intraday OHLCV only when Ripple mode is enabled
- Corporate actions and adjustment factors
- Trading status and liquidity measures
- Index OHLCV and constituent breadth inputs
- Current derivative eligibility and contract master
- Futures price, volume, OI, expiry, lot size, and margin
- Options strikes, expiries, bid/ask, last, volume, OI, OI change, and IV

## Freshness labels

- `LIVE`: provider confirms a real-time feed and timestamp is within tolerance.
- `DELAYED`: provider delay is known or timestamp exceeds live tolerance.
- `INTRADAY`: current-session data; incomplete bars are provisional.
- `EOD`: latest completed official trading session.

Record provider time and retrieval time separately. Use `Asia/Kolkata` for exchange-facing display and retain UTC internally.

## Validation

Quarantine a record when any required check fails:

- Unknown or ambiguous symbol mapping
- Duplicate stable instrument identifier
- Missing or non-positive OHLC
- High below low
- Close outside high-low range
- Negative volume or open interest
- Unexpected bar gaps
- Corporate-action discontinuity without a valid adjustment
- Stale timestamp
- Contract fields inconsistent with the current contract master
- Material timestamp mismatch between spot and derivatives

Data quality states are `PASS`, `PARTIAL`, `STALE`, `INVALID`, and `NO_DATA`. Only `PASS` may satisfy a hard freshness gate.

## Universe rules

- Refresh all four memberships daily or when official files change.
- Store membership effective dates.
- Deduplicate constituents by stable instrument identifier.
- Preserve all memberships on the stock record.
- Never use historical training spreadsheets as the current constituent, lot-size, expiry, or margin authority.

## Reproducibility

Persist immutable raw snapshots or provider references, checksums where practical, normalized datasets, adjustment versions, and the latest completed bar used by each run.

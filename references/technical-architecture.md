# Technical Architecture

## Components

1. **Document registry** — source inventory, hashes, provenance, extraction status.
2. **Rule registry** — original wording, normalized expressions, versions, parameters, conflicts.
3. **Universe service** — current and point-in-time index memberships.
4. **Market-data ingestion** — raw immutable snapshots and provider metadata.
5. **Normalization and quality** — symbols, adjustments, calendars, validation, quarantine.
6. **Feature engine** — indicators, pivots, patterns, relative strength, derivative metrics.
7. **Rule engine** — deterministic evaluation with full traces.
8. **Ranking engine** — tiers and scores after hard gates.
9. **Backtest engine** — point-in-time simulation, costs, slippage, portfolios, benchmarks.
10. **Reporting API and web UI** — read-only presentation of stored results.

## Layer boundaries

```text
Providers
  → Raw snapshots
  → Normalized point-in-time data
  → Derived features
  → Rule results
  → Tier/rank results
  → Reports and UI
```

Do not let the UI calculate authoritative signals. Do not let the rule engine fetch ad hoc market data. Every layer must receive an explicit snapshot/version identifier.

## Suggested storage entities

- `instruments`
- `index_memberships`
- `market_bars_raw`
- `market_bars_adjusted`
- `corporate_actions`
- `derivative_contracts`
- `derivative_snapshots`
- `data_quality_results`
- `strategy_versions`
- `parameter_versions`
- `rule_definitions`
- `screening_runs`
- `instrument_run_results`
- `rule_traces`
- `rankings`
- `backtest_runs`
- `backtest_trades`

## Job sequence

1. Refresh calendar, memberships, and contract master.
2. Ingest a coherent market snapshot.
3. Normalize and validate.
4. Compute features for four indexes and all deduplicated stocks.
5. Evaluate index context.
6. Evaluate every stock and eligible derivative overlay.
7. Reconcile coverage.
8. Rank qualifying/near-qualifying stocks.
9. Persist immutable results.
10. Publish only after quality and coverage checks pass.

## Reliability requirements

- Idempotent jobs keyed by run ID and snapshot ID
- Retry bounded transient provider errors without changing input semantics
- Quarantine bad instruments without silently dropping them
- Explicit partial-run status
- Formula and golden-case tests for every deterministic rule
- Time-travel tests preventing future data access
- Audit log for rule/parameter changes
- Provider secrets only in environment/secret storage, never repository files

## API boundaries

- `GET /runs` and `GET /runs/{id}`
- `GET /runs/{id}/indexes`
- `GET /runs/{id}/stocks`
- `GET /runs/{id}/stocks/{instrumentId}`
- `GET /strategies` and `GET /strategies/{version}`
- `POST /screening-runs` for authorized manual execution
- `POST /backtests` for authorized research jobs

Execution/trading endpoints are intentionally out of scope.

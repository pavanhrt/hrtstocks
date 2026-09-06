# Project Overview

## Objective

Build a web application that refreshes NIFTY 50, NIFTY Bank, NIFTY 100, and NIFTY 500 membership and market data each trading day; analyzes the four indexes; analyzes every unique constituent; applies SMM, PAPA, GUE, risk, and eligible FOME rules; and returns an auditable complete ledger plus a ranked research shortlist.

## Users

- Researcher reviewing current candidates and near matches
- Strategy owner validating extracted rules and conflicts
- Analyst reviewing charts, fundamentals, and risk
- Developer maintaining ingestion, rule engines, backtests, and UI

## Core product views

1. Daily run dashboard
2. Index regime analysis
3. Complete all-stock ledger
4. Ranked candidates and near matches
5. Individual stock rule trace
6. Strategy/version manager
7. Backtest results and comparison
8. Data health and source audit

## Non-goals

- Automatic order placement
- Guaranteed predictions
- Personalized investment advice
- Hidden discretionary changes to documented rules
- A shortlist that omits the result of non-qualifying constituents

## Success criteria

- Every current constituent has exactly one terminal result.
- Every result is reproducible from stored inputs and versions.
- Every rule links to its source or is labeled as a project default.
- Stale or invalid data cannot produce a pass.
- Backtests prevent look-ahead and disclose survivorship limitations.
- A non-technical user can understand why a stock passed or failed.

---
name: backtesting
description: Backtest versioned stock-screening strategies with point-in-time data, realistic execution, costs, risk limits, and bias controls. Use to validate original or explicitly separate optimized variants; do not present in-sample optimization as validated performance.
---

# Backtesting

## Outcome

Produce a reproducible estimate of strategy behavior, limitations, and robustness without look-ahead or hidden rule changes.

Read [../../AGENTS.md](../../AGENTS.md), the relevant files in [../../strategies](../../strategies), and [../../references/market-data-policy.md](../../references/market-data-policy.md).

## Required design

1. Freeze rule, parameter, universe, data, cost, and execution-model versions.
2. Use point-in-time index membership where available; otherwise disclose survivorship bias.
3. Generate close-confirmed signals only from information known at that close.
4. Execute at the next realistically tradable price unless a documented intraday trigger is being tested.
5. Prevent future-confirmed pivots, completed wave labels, future corporate actions, and future contract data from leaking backward.
6. Model corporate actions, brokerage, exchange charges, taxes, spread, slippage, liquidity, expiry, and rollover as applicable.
7. Enforce position, allocation, portfolio, and monthly-loss constraints through time.
8. Separate development, validation, and out-of-sample periods.
9. Use walk-forward or rolling evaluation for tuned parameters.
10. Compare the original strategy with separately versioned variants and simple benchmarks.

## Required metrics

- Candidate and trade counts
- Win rate and average win/loss
- Expectancy and profit factor
- CAGR/annualized return where appropriate
- Maximum drawdown and recovery time
- Exposure, turnover, holding period, and capacity/liquidity indicators
- Performance by market regime, tier, direction, and index membership
- Cost and slippage sensitivity
- Parameter stability and out-of-sample degradation

## Required comparisons

- SMM only
- SMM plus PAPA
- SMM plus PAPA plus GUE
- Equity system plus eligible FOME overlay
- Simple benchmark and no-skill baseline where meaningful

## Publication rule

Label results `EXPLORATORY`, `VALIDATION`, or `OUT_OF_SAMPLE`. Never describe a strategy as validated solely because it performs well on the period used to design or optimize it.

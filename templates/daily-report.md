# Daily Stock Research Report

> Research support only. Not investment advice or an order instruction.

## Run status

| Field | Value |
|---|---|
| Run ID | `{{run_id}}` |
| Status | `{{complete_or_partial}}` |
| Mode | `{{EOD_INTRADAY_LIVE_DELAYED}}` |
| Exchange time | `{{exchange_timestamp}}` |
| Latest completed bar | `{{latest_completed_bar}}` |
| Data snapshot | `{{snapshot_id}}` |
| Rule version | `{{rule_version}}` |
| Parameter version | `{{parameter_version}}` |
| Providers | `{{providers}}` |

## Executive conclusion

{{plain_language_conclusion}}

## Coverage and data quality

| Measure | Count |
|---|---:|
| NIFTY 50 members | {{nifty_50_count}} |
| NIFTY Bank members | {{nifty_bank_count}} |
| NIFTY 100 members | {{nifty_100_count}} |
| NIFTY 500 members | {{nifty_500_count}} |
| Unique stocks after deduplication | {{unique_stock_count}} |
| Valid | {{valid_count}} |
| Partial | {{partial_count}} |
| Stale | {{stale_count}} |
| Invalid | {{invalid_count}} |
| No data | {{no_data_count}} |

Coverage reconciliation:

`{{unique_stock_count}} = {{tier_a}} + {{tier_b}} + {{watch}} + {{manual_review}} + {{rejected}} + {{unavailable}}`

Result: `{{coverage_pass_fail}}`

## Index analysis

{{index_analysis_table}}

## Ranked research candidates

| Rank | Symbol | Memberships | Direction | Tier | Score | Price/time | SMM | PAPA | GUE | FOME | Entry confirmation | Stop | Target | R/R | Primary risk |
|---:|---|---|---|---|---:|---|---|---|---|---|---|---:|---:|---:|---|
{{ranked_candidate_rows}}

If empty: `NO QUALIFYING CANDIDATES — documented gates were not weakened.`

## Near matches

| Symbol | Direction | Missing confirmation | Current value | Required condition | State |
|---|---|---|---:|---|---|
{{near_match_rows}}

## Complete all-stock ledger

The attached/exported ledger must contain exactly one row per unique constituent, including failures and unavailable stocks.

| Symbol | Company | Instrument ID | Memberships | Price/time | Data quality | Bull case | Bear case | SMM | PAPA | GUE | FOME | Terminal state | Tier | Primary reason | Trace ID |
|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|
{{all_stock_rows}}

## Rejections and unavailable results

{{rejection_and_unavailable_summary}}

## Limitations and conflicts

{{limitations_conflicts_and_manual_items}}

## Method note

Facts, calculations, model-assisted interpretations, and unresolved judgments are labeled separately. Historical statistics include their test period, costs, slippage assumptions, and known biases.

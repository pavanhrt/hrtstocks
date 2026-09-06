---
name: stock-screening
description: Apply the versioned SMM, PAPA, GUE, risk, and eligible FOME rules to four NIFTY indexes and every unique constituent stock. Use for daily screens, all-stock ledgers, ranked candidates, near matches, and explanations; do not place trades.
---

# Stock Screening

## Outcome

Return separate index context, one terminal result for every unique constituent, and a ranked research shortlist derived from that complete ledger.

Read [../../AGENTS.md](../../AGENTS.md), [../../strategies/shared-gates.yaml](../../strategies/shared-gates.yaml), and the requested framework specifications in [../../strategies](../../strategies). Require a validated snapshot from `market-research`.

## Evaluation order

1. Load immutable snapshot, universe, rule version, and parameter version.
2. Compute documented common features from information available at the evaluation time.
3. Analyze all four index instruments using SMM, PAPA, and GUE context rules.
4. For every unique constituent, run data and eligibility gates.
5. Evaluate bullish and bearish SMM hypotheses independently.
6. Apply PAPA context, setup, trigger, follow-up, stop, and target rules.
7. Apply GUE count/setup rules with confidence and alternatives.
8. Calculate risk, reward/risk, and position-size ceilings.
9. Apply FOME only to currently derivative-eligible stocks; otherwise return `NOT_APPLICABLE` without penalty.
10. Assign exactly one terminal stock result, then tier and rank.
11. Reconcile complete coverage before publication.

## Rule behavior

- Deterministic gates use `PASS`, `FAIL`, `WATCH`, or `NO_DATA` exactly as defined.
- Subjective or unresolved rules use `MANUAL_REVIEW`.
- A failed hard gate prevents Tier A and Tier B.
- Index alignment is context, not a substitute for the stock's signal.
- Rank only within the same direction and tier.
- Keep derivative fit separate from the core equity score.
- Never lower thresholds to populate a report.

## Required artifacts

- Run summary and coverage reconciliation
- Four-row index analysis table
- Complete all-stock ledger, including rejected and unavailable stocks
- Tier A, Tier B, Watch, Manual Review, Rejected, and Unavailable views
- Per-stock and per-rule trace
- Ranked shortlist linked to ledger rows
- Limitations and unresolved conflicts

Use [../../templates/daily-report.md](../../templates/daily-report.md), [../../templates/index-analysis.md](../../templates/index-analysis.md), and [../../templates/stock-analysis.md](../../templates/stock-analysis.md).

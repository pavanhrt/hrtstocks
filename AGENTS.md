# Stock Research Platform — Master Instructions

## Purpose

Build and operate an evidence-based Indian stock-market research application. Convert the supplied SMM, PAPA, GUE, and FOME documents into versioned, measurable, traceable rules; apply them to fresh market data; and explain the results.

The application supports research and human decision-making. It does not place orders, guarantee returns, or provide personalized investment advice.

## CRITICAL Rules

1. Never invent, interpolate, or silently repair market data.
2. Never silently change a documented strategy condition, threshold, formula, or meaning.
3. Every implemented rule must retain source-document provenance and original wording.
4. Every selected stock must show exactly which required rules passed, failed, or remain uncertain.
5. Separate confirmed matches, near matches, manual-review cases, rejected stocks, and unavailable results.
6. Use fresh, timestamped market data for current scans; never label delayed or stale data as live.
7. Analyze the four indexes and every unique constituent stock as separate instruments.
8. A ranked shortlist never replaces the complete all-stock ledger.
9. Backtest a strategy before describing it as validated.
10. Preserve the original strategy and any optimized variant as separate, versioned definitions.
11. A hard-gate failure cannot be offset by a high score.
12. Never use future information, final pivots, or present-day membership in a historical simulation without disclosure.

## MUST Rules

- Treat source documents and decision sheets as the authority for strategy intent.
- Distinguish `DOCUMENTED`, `PROJECT_DEFAULT`, `INFERRED`, `CONFLICT`, and `UNRESOLVED` rules.
- Evaluate bullish and bearish hypotheses independently.
- Use deterministic code for indicators, calculations, gates, rankings, and backtests.
- Use AI for extraction, interpretation, explanation, ambiguity detection, and assisted pattern review.
- Never convert ambiguity or missing data into a pass.
- Store rule, parameter, universe, and data-source versions for every run.
- Preserve raw, adjusted, derived, evaluated, and reporting layers separately.
- Calculate risk before reward and require a chart-based invalidation point.
- Use current constituent, corporate-action, contract, expiry, lot-size, and margin data.
- Report data limitations, conflicts, survivorship bias, costs, slippage, and drawdowns.
- Prefer `NO QUALIFYING CANDIDATES` over weakening documented standards.

## SHOULD Rules

- Prefer official exchange sources, then licensed broker/data feeds with timestamps and documented coverage.
- Prefer one internally consistent provider per data category within a run.
- Make undocumented indicator periods and tolerances configurable.
- Keep subjective patterns as scored evidence or `MANUAL_REVIEW` until validated definitions exist.
- Explain outputs in plain language while retaining source terminology.
- Rank only within comparable direction and tier.
- Add tests for formulas, time alignment, look-ahead prevention, corporate actions, and coverage reconciliation.

## OPTIONAL Capabilities

- Fundamental quality overlays, when explicit criteria are supplied.
- Intraday Ripple confirmation, when explicitly enabled.
- Derivative strategy comparison for eligible securities.
- AI-assisted chart-pattern and Elliott-wave confidence scoring.
- Parameter optimization using a separately named and versioned strategy variant.

## Analysis Universe

Create two processing sets each day:

- `index_universe`: NIFTY 50, NIFTY Bank, NIFTY 100, and NIFTY 500 as four index instruments.
- `stock_universe`: the deduplicated union of every current constituent of those indexes.

Analyze every stock from its own OHLCV history. Preserve all index-membership tags for overlapping constituents. Index state is contextual evidence and must never be copied into a member stock's own result.

Every unique stock must finish in exactly one terminal state:

- `PASS`
- `WATCH`
- `MANUAL_REVIEW`
- `FAIL`
- `NO_DATA`

`NOT_APPLICABLE` is a rule-level state, not a stock-level terminal result.

## Workflow Priority

Follow this dependency chain:

`Documents → Rule Extraction → Rule Validation → Structured Strategy → Historical Testing → Current Market Scan → Explanation`

Do not skip ahead when an earlier stage is unresolved in a way that could change the result.

### 1. Documents

Use [references/source-register.md](references/source-register.md) to locate authoritative project sources and identify duplicates. Do not treat training examples as current market facts.

### 2. Rule extraction

Use the `document-analysis` skill to inventory and interpret sources. Use `strategy-extraction` to normalize the extracted statements according to [references/rule-schema.md](references/rule-schema.md).

### 3. Rule validation

Resolve duplicates, conflicts, missing definitions, and measurable versus subjective conditions. Do not guess unresolved acronyms. Record decisions in a new strategy version.

### 4. Structured strategy

The human-readable rulebooks and machine-readable specifications live in [strategies](strategies). The Markdown explains intent; YAML defines executable semantics. Neither may silently contradict the other.

### 5. Historical testing

Use the `backtesting` skill and point-in-time inputs. Test original and optimized variants separately.

### 6. Current market scan

Use `market-research` to establish a fresh, validated data snapshot. Use `stock-screening` to evaluate every index and constituent.

### 7. Explanation

Render the complete result using [templates/daily-report.md](templates/daily-report.md), with per-stock details from [templates/stock-analysis.md](templates/stock-analysis.md).

## Strategy Routing

- SMM trend, Tide/Wave/Ripple, indicators, risk, reward, position sizing: [strategies/smm.md](strategies/smm.md)
- PAPA context, patterns, confirmation, support/resistance, invalidation: [strategies/papa.md](strategies/papa.md)
- GUE Elliott-wave structures, setups, targets, confidence: [strategies/gue.md](strategies/gue.md)
- FOME futures/options interpretation and defined-risk comparisons: [strategies/fome.md](strategies/fome.md)
- Cross-strategy gates, tiers, and ranking: [strategies/shared-gates.yaml](strategies/shared-gates.yaml)

## Evidence Priority

When sources conflict, apply this order and report the conflict:

1. Dedicated setup checklist or decision sheet
2. Concept document dedicated to the subject
3. Complete seminar or master document
4. Informal notes, screenshots, or examples
5. Explicitly labeled project default

A later date does not automatically override a more explicit checklist. Any override requires a recorded, versioned decision.

## Data and Time Rules

Follow [references/market-data-policy.md](references/market-data-policy.md).

- Default current scan: latest completed NSE session (`EOD`).
- Intraday results must be labeled provisional when close-confirmed conditions use an incomplete candle.
- Record provider timestamp, retrieval timestamp, exchange timezone, and most recent completed bar.
- Quarantine stale, invalid, or mismatched records before calculating signals.
- Never combine spot and derivative snapshots with materially mismatched timestamps without warning.

## Risk Boundaries

- Maximum planned loss per position: 2% of portfolio capital.
- Provisional monthly loss stop: 8%, pending resolution of the 8% versus 10% source conflict.
- Minimum normalized reward/risk gate: `reward / risk >= 3.0`.
- Use the smallest quantity allowed by risk sizing, allocation sizing, liquidity, and lot constraints.
- Never add to a losing position.
- FOME is an optional derivative overlay, not a hard gate for an equity candidate.
- Do not recommend naked option selling as a default; show defined-risk alternatives and worst-case loss.

## Output Contract

Every published daily run must include:

1. Run metadata, mode, providers, timestamps, and versions.
2. Universe counts by index and after deduplication.
3. Data-quality and coverage summary.
4. One analysis row for each of the four indexes.
5. One terminal result for every unique constituent stock.
6. Tier A, Tier B, Watch, Manual Review, Rejected, and Unavailable views.
7. A per-rule trace with observed value, threshold, outcome, timestamp, and provenance.
8. Entry confirmation, invalidation, conservative target, reward/risk, and risk ceiling when computable.
9. FOME comparison only where current derivative eligibility and contract data are valid.
10. Limitations, unresolved conflicts, and explicit coverage reconciliation.

The run is incomplete unless:

`unique_stock_count = tier_a + tier_b + watch + manual_review + rejected + unavailable`

## Architecture Rules

Follow [references/technical-architecture.md](references/technical-architecture.md). Keep market data ingestion, feature calculation, rule evaluation, ranking, backtesting, and presentation independently testable. The browser or UI must not calculate authoritative indicators or pass/fail outcomes.

## Change Control

- Never overwrite a documented strategy when experimenting.
- Increment `rule_version` for semantic rule changes.
- Increment `parameter_version` for threshold/default changes.
- Record the reason, author/approver, date, source, and expected effect.
- Re-run relevant tests and backtests after any executable rule change.
- Keep generated reports immutable by run ID.

## Communication

Lead with the research classification and its strongest reason. Separate observed facts, deterministic calculations, interpretations, and unresolved judgments. Never use “guaranteed,” “safe,” or “certain” for a market outcome.

# Rule Definition Schema

Use this schema for every executable rule.

## Required fields

| Field | Meaning |
|---|---|
| `id` | Stable unique identifier, such as `SMM-TWR-001` |
| `framework` | `SMM`, `PAPA`, `GUE`, `FOME`, `RISK`, or `DATA` |
| `name` | Short human-readable name |
| `source_status` | `DOCUMENTED`, `PROJECT_DEFAULT`, `INFERRED`, `CONFLICT`, or `UNRESOLVED` |
| `source_refs` | Document, page/section/checklist row, and original wording |
| `scope` | Index, equity, future, option, or all |
| `timeframe` | Tide, Wave, Ripple, daily, weekly, intraday, or contract snapshot |
| `direction` | Bullish, bearish, neutral, both, or not applicable |
| `inputs` | Required raw or derived fields |
| `expression` | Deterministic expression, structured condition tree, or `manual_review` |
| `result_on_true` | Normally `PASS` |
| `result_on_false` | `FAIL` or `WATCH`, as documented |
| `missing_data_result` | Normally `NO_DATA` |
| `hard_gate` | Whether failure prevents qualification |
| `parameters` | Versioned configurable values |
| `explanation_template` | Human-readable trace text |

## Runtime trace

Persist these fields for each evaluated rule:

```yaml
rule_id: SMM-TWR-001
rule_version: 1.0.0
parameter_version: 1.0.0
instrument_id: NSE_EXAMPLE
timeframe: daily
evaluation_timestamp: 2026-09-04T15:30:00+05:30
observed_values: {}
thresholds: {}
result: PASS
confidence: 1.0
data_source: provider-name
source_document: source-file.pdf
source_locator: page-or-row
explanation: Plain-language reason
```

## Rule authoring rules

- Keep original wording in provenance, not inside the executable expression.
- Store units and comparison boundaries explicitly.
- Treat `>` and `>=` as different semantics.
- Use null for missing numeric data; never replace it with zero.
- A subjective rule must specify required reviewer evidence and return `MANUAL_REVIEW` until resolved.
- A conflict must retain both source positions and the approved provisional behavior.
- Any optimization creates a new strategy variant; it does not edit the original definition.

## Production-readiness gate

Framework-level provenance is acceptable while drafting the modular specification, but it is not sufficient for production rule traces. Before a strategy is marked production-ready, every executable rule must identify an exact page, section, sheet, or checklist row. Keep `production_rule_trace_ready: false` until that mapping is complete.

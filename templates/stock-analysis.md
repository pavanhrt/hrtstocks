# Stock Analysis — {{company}} ({{symbol}})

> Research classification only; not an instruction to trade.

## Classification

`{{terminal_classification}}`

Primary reason: {{primary_reason}}

| Field | Value |
|---|---|
| Instrument ID | `{{instrument_id}}` |
| Index memberships | {{memberships}} |
| Price and timestamp | {{price_timestamp}} |
| Data quality | `{{data_quality}}` |
| Direction | `{{bullish_bearish_neutral}}` |
| Tier / score | {{tier_score}} |
| Rule / parameter version | {{versions}} |

## Index context

{{index_alignment_relative_strength_and_divergence}}

## SMM

| Rule | Observed evidence | Required condition | Result |
|---|---|---|---|
{{smm_rule_rows}}

## PAPA

| Context / setup / trigger | Evidence | State |
|---|---|---|
{{papa_rule_rows}}

## GUE

| Item | Result |
|---|---|
| Primary count | {{primary_wave_count}} |
| Alternative count(s) | {{alternative_wave_counts}} |
| Confidence | {{wave_confidence}} |
| Invalidation | {{wave_invalidation}} |
| Target confluence | {{wave_targets}} |

## Risk and scenario levels

| Item | Value |
|---|---:|
| Entry confirmation | {{entry_confirmation}} |
| Stop / invalidation | {{stop}} |
| Conservative target | {{conservative_target}} |
| Extended target | {{extended_target}} |
| Risk per share | {{risk_per_share}} |
| Reward/risk | {{reward_risk}} |
| Risk-sized quantity ceiling | {{risk_quantity}} |
| Final quantity ceiling | {{final_quantity}} |

## FOME overlay

Applicability: `{{fome_applicability}}`

{{fome_strategy_comparison}}

## Failed, pending, and uncertain evidence

{{fail_watch_manual_review_items}}

## Traceability

| Rule ID | Observed value | Threshold | Result | Source timestamp | Document provenance |
|---|---|---|---|---|---|
{{rule_trace_rows}}

## Limitations

{{limitations}}

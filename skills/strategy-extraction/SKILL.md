---
name: strategy-extraction
description: Convert provenance-backed stock-strategy statements into versioned human-readable and machine-readable rules. Use after document extraction or when maintaining SMM, PAPA, GUE, FOME, risk, gate, or ranking definitions; do not use to optimize rules silently.
---

# Strategy Extraction

## Outcome

Create a reviewable Markdown rulebook and YAML rule definition whose semantics match the source evidence.

Read [../../AGENTS.md](../../AGENTS.md), [../../references/rule-schema.md](../../references/rule-schema.md), and the relevant extraction records before editing a strategy.

## Workflow

1. Group source statements by concept and decision stage.
2. Apply the evidence priority in `AGENTS.md`.
3. Label each condition `DOCUMENTED`, `PROJECT_DEFAULT`, `INFERRED`, `CONFLICT`, or `UNRESOLVED`.
4. Separate prerequisites, triggers, supporting evidence, hard gates, scoring features, invalidations, stops, targets, sizing, and exits.
5. Translate measurable conditions into explicit operators, periods, timeframes, units, and missing-data behavior.
6. Translate subjective conditions into evidence requirements plus `MANUAL_REVIEW`; do not fabricate precision.
7. Record source wording and provenance beside the normalized rule.
8. Update both the framework Markdown and YAML files.
9. Increment the correct rule or parameter version and add a change reason.
10. Validate YAML, identifiers, cross-references, and contradictions.

## Invariants

- A rule ID remains stable while its meaning remains stable.
- Semantic changes increment `rule_version`.
- Threshold/default changes increment `parameter_version`.
- Original and optimized variants have different IDs and versions.
- Missing numeric inputs remain null and produce `NO_DATA` when required.
- A hard-gate failure remains visible even if scoring is strong.
- `FOME` is canonical; `FOAM` is accepted only as a user alias.

## Deliverable

Return changed rules, evidence sources, unresolved decisions, version changes, affected tests/backtests, and a concise human review checklist.

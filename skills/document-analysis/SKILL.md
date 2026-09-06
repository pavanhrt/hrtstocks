---
name: document-analysis
description: Inspect the project's stock-market PDFs, spreadsheets, Word files, HTML exports, and duplicates to extract source-faithful concepts with provenance. Use for source inventory, document comparison, or ambiguity discovery; do not use to run a market screen.
---

# Document Analysis

## Outcome

Produce a traceable inventory of strategy statements without converting uncertain language into invented rules.

Read [../../AGENTS.md](../../AGENTS.md) and [../../references/source-register.md](../../references/source-register.md) first.

## Workflow

1. Identify the requested framework, document, or setup.
2. Check the source register and group byte-identical or obvious download duplicates.
3. Extract text, tables, formulas, labels, chart annotations, and checklist rows using a method appropriate to the file type.
4. Preserve original wording, document name, page/sheet/row, and nearby context.
5. Classify each statement as definition, prerequisite, trigger, confirmation, invalidation, stop, target, sizing, exit, example, or commentary.
6. Compare repeated statements and record agreements, conflicts, spelling variants, and missing definitions.
7. Produce an extraction record for `strategy-extraction`; do not silently normalize semantics here.

## Required extraction fields

- Framework and concept/setup
- Exact source and locator
- Original wording or faithful short paraphrase
- Statement category
- Direction and timeframe, if explicit
- Numeric threshold, operator, and units, if explicit
- Dependencies and exceptions
- Confidence in extraction quality
- Duplicate/conflict/unresolved status

## Guardrails

- Treat source examples as examples, not current market facts or universal thresholds.
- Do not infer undefined acronyms from general trading knowledge.
- Do not assign a formula to a visually subjective term unless the source does.
- Keep handwritten/chart-image evidence separate from machine-readable checklist evidence.
- If OCR or table structure is unclear, flag the exact region for manual review.
- Do not resolve source conflicts by choosing whichever produces more candidates.

## Handoff

Return an extraction table and a conflict list. Link every extracted item to its source. When executable rules are requested, continue with [../strategy-extraction/SKILL.md](../strategy-extraction/SKILL.md).

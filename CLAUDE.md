# Claude Project Instructions

Read [AGENTS.md](AGENTS.md) as the master project authority before working on this repository.

The detailed strategy rules are intentionally modular. Load only the skill and strategy files required by the task, but always retain the CRITICAL rules from `AGENTS.md`.

## Required routing

- Source-document work: `skills/document-analysis/SKILL.md`
- Converting prose to rules: `skills/strategy-extraction/SKILL.md`
- Daily index and all-stock scan: `skills/stock-screening/SKILL.md`
- Historical validation: `skills/backtesting/SKILL.md`
- Current market facts and data quality: `skills/market-research/SKILL.md`

Never invent data, silently change strategy logic, omit failed stocks from coverage, or merge optimized rules into the original strategy.

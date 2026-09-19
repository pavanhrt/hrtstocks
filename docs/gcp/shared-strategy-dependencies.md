# Retained shared strategy dependencies: `BSP-*` and `SSP-*`

**Decision (owner, accepted):** keep both playbooks and all their rules for now. Removing the Buy Signals / Sell Signals *pages* does **not** authorize changing the underlying ranking strategy.
Nothing in this migration changes classification behavior for these rules.

| Item | Path | Why it is retained |
|---|---|---|
| Buy playbook | `strategies/buy-signal-playbook.yaml` (`BSP-M1 … BSP-M8`) | Buy Setup Analysis reads **`BSP-M1`** (monthly) and **`BSP-M3`** (weekly) as its first two gates: `buy_setup_analysis_ledger` view (`db/migrations/0011`, `0014`), `services/pipeline/src/analyze-buy-setup/index.js` (`loadTimeframeGateResults`), `app/src/lib/data/buy-setup-analysis.ts` |
| Sell playbook | `strategies/sell-signal-playbook.yaml` (`SSP-S1 … SSP-S8`) | evaluated with every run; participates in tier classification (below) |
| Tier classification | `services/pipeline/src/run-screening/rank.js` `classify()` | pools `MANUAL_REVIEW` traces from **every** evaluated rule, so the `MANUAL_REVIEW` sentinel rules of both playbooks help decide which tier each stock lands in. This drives the Dashboard, Stock ledger and rankings |
| Seeding | `services/pipeline/src/seed/parse-strategies.mjs` (+ test) | both playbooks are in the seeded file list |

Also unchanged: `strategies/buy-swing.yaml` / `sell-swing.yaml` (the `/analysis` pages) and the `rule_definitions` / `rule_traces` rows already produced.

**What was removed** was only the UI and its exclusive plumbing: the three pages, `app/src/lib/data/signals.ts`, their navigation links and one link. No table, column, rule, job or classification code was deleted.

Changing or removing these rules is a strategy change under `AGENTS.md` Change Control (`rule_version` bump, recorded reason/approver, re-run tests, and re-baseline tiers), to be decided separately.

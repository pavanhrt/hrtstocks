# Direction/Analysis rebuild — lead-agent architecture plan

Status: **Phase 0 (contracts) — in progress.** This is the shared-contracts document required
before any parallel agent work starts, per the build authorization's own instruction ("first have
the lead agent define shared schemas, types, status vocabulary, and file ownership"). Nothing in
this document has been applied to the database or deployed. `supabase/migrations/` still only goes
through `0005_direction_analysis.sql`.

Companion document (produced by the rules/provenance agent, separately): `docs/swing-strategy-extraction.md`
— full extraction of the Weekly→Daily→1H BUY/SELL playbooks with source locators. Read that before
writing any swing-strategy YAML; this document does not restate its contents.

## 1. How to use this document

This is the map for a multi-session rebuild. Each phase below is independently completable,
testable, and mergeable — none of them require the others to be "fake-finished" to be genuinely
done. Do not skip ahead to a later phase's implementation before its dependencies (listed per
phase) are actually merged.

## 2. Baseline audit — confirmed findings

Every item below is the *current, verified* state of the code in this repo (`develop` branch,
commit `5635392` at time of writing), not a hypothesis. File:line citations are exact.

| # | Problem (from spec) | Verified location | Status |
|---|---|---|---|
| 1 | Confluence calculated client-side | `app/src/app/(app)/direction/DirectionTable.tsx:9-15` — `confluenceOf()` runs in the browser from 3 `dow_state` strings only | CONFIRMED |
| 2 | Direction doesn't combine SMM/GUE/PAPA | `supabase/functions/run-screening/features/direction.js` only calls `classifyDowStructure` (SMM Dow theory) + `labelWave` (a thin GUE heuristic). No PAPA pattern evidence anywhere in the direction pipeline | CONFIRMED |
| 3 | No pattern/breakout/target/invalidation display | Same file; `instrument_direction` table (migration `0005`) has no pattern columns at all | CONFIRMED |
| 4 | Elliott only recognizes completed 6-pivot impulse, mislabels as "wave 5 of 5", treats near-any 4 pivots as A-B-C, no primary/alt count or invalidation | `supabase/functions/run-screening/features/wave.js` — `tryImpulse()` requires exactly the last 6 pivots and hardcodes the label `Impulse wave 5 of 5`; `tryCorrection()` only checks `labeledPivots.length >= 4` with no shape validation at all | CONFIRMED — this is the module I wrote earlier this session, scoped then as "best-effort heuristic," which the spec correctly identifies as insufficient for the Direction page's authority requirement |
| 5 | Equal pivots biased into HH/HL | `supabase/functions/run-screening/features/structure.js:230-246` (`labelPivotSequence`) — explicit `: "HH"` / `: "HL"` fallback for the "equal" case, no `EH`/`EL`/range label exists | CONFIRMED |
| 6 | Direction table mixes runs | `app/src/lib/data/direction.ts` queries `instrument_direction` (latest-state table) with no `run_id` coherence check across the 3 timeframe rows for one instrument | CONFIRMED |
| 7 | Chart hash incomplete | `supabase/functions/run-screening/features/direction.js` `hashDirectionInputs()` hashes only `pivots` + last bar date/close — not the full displayed OHLCV window, algorithm version, parameters, or renderer version | CONFIRMED |
| 8 | Only 365 days fetched | `supabase/functions/run-screening/index.js:48` `OHLCV_LOOKBACK_DAYS = 365`, capped by Fyers' own 366-day single-request limit (see `providers/fyers.js` comment) — needs a multi-request backfill to get real history | CONFIRMED |
| 9 | Time-budget skip becomes terminal NO_DATA | `supabase/functions/run-screening/index.js` `recordSkippedForTimeBudget()` writes `terminal_state: "NO_DATA", tier: "unavailable"` directly — indistinguishable from a real data failure, and `reconcileCoverage()` happily calls this "reconciled" | CONFIRMED |
| 10 | Fyers rate limiter is per-isolate | `supabase/functions/run-screening/providers/fyers.js:30` `let nextAvailableAt = 0` — module-level, resets every cold isolate, not shared across concurrent invocations. **Directly caused the incident earlier this session** (5 concurrent runs collectively exceeding 200/min) | CONFIRMED |
| 11 | "Already running" check not atomic, no stale-lease recovery | `supabase/functions/run-screening/index.js` (added this session, v12) does `select ... status='running'` then `insert` — classic check-then-act race, no unique constraint backing it, and no auto-recovery for a hard-killed run (had to be fixed by hand via SQL this session) | CONFIRMED, partially mitigated (reduces but doesn't close the race; no stale-lease timeout) |
| 12 | `getLatestRun()` can return running/partial/failed | `app/src/lib/data/runs.ts` `getLatestRun()` — no `.eq("status", ...)` filter at all, ordered only by date | CONFIRMED |
| 13 | Buy/Sell pages are positional M→W→D, not the requested W→D→1H | `app/src/app/(app)/buy-signals/page.tsx:92-93` — page's own subtitle: *"strategies/buy-signal-playbook.yaml (positional, Monthly → Weekly → Daily)"* | CONFIRMED |
| 14 | "Highly recommended" used for codeable-only pass | `app/src/app/(app)/buy-signals/page.tsx:114` heading literally reads `Highly recommended -- cleared every codeable gate`, despite the page's own body text admitting this isn't a full pass | CONFIRMED |
| 15 | Bullish/bearish pooled into one classification | `supabase/functions/run-screening/rank.js` `classify()` takes one `traces` array with no direction split; `instrument_run_results` (migration `0001`) has a single `terminal_state`/`tier`/`direction` per instrument per run, not one per hypothesis | CONFIRMED |
| 16 | Ranking totals 70 of declared 100 | `supabase/functions/run-screening/rank.js` — `COMPONENT_WEIGHTS` declares all 6 components (`SMM:25, PAPA:30, GUE:15, RISK_REWARD:10, DATA_LIQUIDITY:5, VOLUME_MOMENTUM:15` = 100), but `scoreComponents()`'s loop only iterates `["SMM",25],["PAPA",30],["GUE",15]` = 70; the other 3 are declared and never computed | CONFIRMED, exact root cause identified |
| 17 | Draft/framework-only rules in production | Not yet independently verified this session — needs the rules/provenance agent's extraction + a pass over `strategy_versions.is_active` / `rule_definitions.source_status` to confirm which `UNRESOLVED`/`source_status` rows are actually being evaluated. **Flagged, not yet confirmed.** | NEEDS VERIFICATION |
| 18 | Zigzag/tolerance values stored as documented, should be PROJECT_DEFAULT/INFERRED | `config/parameters.yaml` already discloses this honestly in comments (`zigzag_*_pct` and the 0.5% tolerance in `structure.js` are commented as non-official midpoints) but they still live under the `documented:` YAML key, not `project_defaults_requiring_backtest:` — the machine-readable classification doesn't match the human-readable disclosure | CONFIRMED |
| 19 | DMI/ADX 14,14 unimplemented | `supabase/functions/run-screening/features/indicators.js` has no ADX/DMI function at all; `config/parameters.yaml` lists `adx_dmi_period: null` under `project_defaults_requiring_backtest` | CONFIRMED |
| 20 | No corporate-action adjustment boundary | `market_bars_raw` is the only bars table actually written to (`market_bars_adjusted` exists in schema, migration `0001`, but nothing in `index.js` ever writes to it); pivots/patterns run on raw bars | CONFIRMED |
| 21 | Aggregation doesn't exclude incomplete periods / NSE holidays | `supabase/functions/run-screening/features/structure.js` `aggregateBars()` groups by ISO week/month key with no holiday calendar and no "is this week/month actually closed yet" gate feeding into the pivot/direction calculation (the `isLatestPeriodPartial()` helper exists but is never called from `direction.js`) | CONFIRMED |
| 22 | `run_date` uses UTC not Asia/Kolkata NSE session | `supabase/functions/run-screening/index.js` — `const runDate = new Date().toISOString().slice(0, 10);` is plain UTC | CONFIRMED |
| 23 | Schema can't store 1-hour bars | `supabase/migrations/0001_schema.sql:151` — `unique (instrument_id, session_date, provider)` on `market_bars_raw` has no `interval`/timestamp component; a daily and hourly bar for the same session would collide | CONFIRMED |
| 24 | Membership rows never deactivated | `supabase/functions/run-screening/index.js` `buildUniverse()` always upserts `is_current: true` for every constituent seen this run; nothing ever sets a dropped constituent's prior row to `is_current: false` | CONFIRMED |
| 25 | Direction signs/loads every chart at once | `app/src/lib/data/direction.ts` `getDirectionAnalysis()` has no pagination — it signs URLs for every non-index instrument's 3 charts in one request (~1,500 signed URLs today) | CONFIRMED |
| 26 | Manual-run button has no durable progress | `app/src/app/(app)/RunScreeningButton.tsx` — `router.refresh()` on success, no polling, no progress display | CONFIRMED |
| 27 | `next` redirect not validated | `app/src/app/login/actions.ts:18` `redirect(next \|\| "/dashboard")` and `app/src/app/auth/callback/route.ts:16` `NextResponse.redirect(\`${origin}${next}\`)` — both take `next` directly from user input (form field / query param) with no same-origin / path-prefix check. Open redirect. | CONFIRMED |
| 28 | Raw Edge Function errors returned to users | `app/src/app/api/screening-runs/route.ts` — `NextResponse.json({ error: \`Edge Function returned ${res.status}: ${text}\` }, { status: 502 })` forwards the raw upstream body | CONFIRMED |
| 29 | Nav is one unresponsive row | `app/src/app/(app)/layout.tsx` — flat `<nav>` of `<Link>`s, no active-state styling, no responsive collapse | CONFIRMED |
| 30 | Login screen sizing/labeling/contrast | Not yet re-verified visually this session against the live QA site; flagged per spec, needs a real browser pass before the UI phase | NEEDS VERIFICATION |

## 3. Status vocabulary (binding across all new work)

These are the canonical enums every new table/module must use. Do not invent parallel vocabularies.

```
run_stage_status:        queued | running | completed | partial | failed
run_lease_status:        active | released | expired
instrument_terminal:     PASS | WATCH | MANUAL_REVIEW | FAIL | NO_DATA   (existing, unchanged)
direction_state:         uptrend_intact | downtrend_intact | sideways_range
                          | confirmed_reversal_bullish | confirmed_reversal_bearish
                          | mixed | manual_review | unavailable
final_alignment:         ALIGNED_BULLISH | ALIGNED_BEARISH | SIDEWAYS | MIXED
                          | MANUAL_REVIEW | UNAVAILABLE
pivot_label:             HH | HL | LH | LL | EH | EL | H | L   (EH/EL = equal-high/equal-low, new)
wave_confidence:         confirmed | tentative | unconfirmed   (existing wave.js vocabulary, kept)
wave_state:              forming | completed
pattern_state:           OBSERVED | TRIGGERED | FAILED | HISTORICAL | MANUAL_REVIEW
gate_result:             PASS | FAIL | WATCH | MANUAL_REVIEW | NO_DATA | NOT_APPLICABLE | CONFLICT (existing rule_result enum, reused)
analysis_action:         BUY | WAIT   (bullish page)   /   SELL | WAIT   (bearish page)
bar_interval:            1d | 1w | 1mo | 1h
data_quality:            PASS | PARTIAL | STALE | INVALID | NO_DATA   (existing, unchanged)
```

`final_alignment` is computed and persisted server-side only, once per (instrument, run). React
never derives it — it reads a column.

## 4. Schema plan (drafted, NOT applied)

New migration file to author in Phase 1 of the pipeline workstream:
`supabase/migrations/0006_durable_pipeline_and_swing_analysis.sql`. Non-destructive: adds tables/
columns, never drops. Sketch (final column types/constraints to be nailed down when written for
real, this is the shape, not the SQL):

- **`screening_run_leases`** — `run_type text`, `run_id uuid`, `acquired_at`, `heartbeat_at`,
  `expires_at`, unique partial index on `(run_type) where status = 'active'` so lease acquisition
  is a single atomic `insert ... on conflict do nothing`, closing problem #11 for real. A
  background sweep (or a check on every acquisition attempt) reclaims a lease whose
  `heartbeat_at` is older than a documented timeout.
- **`pipeline_batches`** — `run_id`, `stage` (`universe|backfill|incremental|aggregation|direction|
  alignment|hourly_ingest|analysis|charts|reconcile`), `cursor`, `attempt`, `status`
  (`pending|in_progress|done|failed`), `last_error`. This is what makes the pipeline resumable
  instead of one 125s request.
- **`instrument_direction_runs`** (new, run-scoped — replaces the "latest-state-only"
  `instrument_direction` as the source of truth; `instrument_direction` becomes a *view* pointing at
  the newest row per instrument+timeframe from a single `run_id`, per problem #6): `run_id`,
  `instrument_id`, `timeframe`, `dow_state`, `pivots jsonb`, `unconfirmed_leg jsonb`,
  `trend_defining_level`, `confirmation_trigger`, `invalidation_level`, `chart_object_path`,
  `chart_input_hash`, `chart_algorithm_version`, `chart_renderer_version`.
- **`elliott_hypotheses`** — `run_id`, `instrument_id`, `timeframe`, `rank` (`primary|alternative`),
  `structure_type` (`impulse|zigzag|flat|triangle|ending_diagonal|...`), `current_wave`,
  `wave_state` (`forming|completed`), `degree`, `rule_arithmetic jsonb` (the 3 hard-rule numbers),
  `confidence`, `invalidation_price`, `invalidation_condition text`.
- **`pattern_detections`** — `run_id`, `instrument_id`, `timeframe`, `pattern_name`, `direction`,
  `state` (`pattern_state` enum above), `anchor_points jsonb`, `neckline_or_boundary jsonb`,
  `trigger_bar_ts`, `target_price`, `invalidation_price`, `volume_evidence jsonb`, `source_locator`.
- **`instrument_alignment`** — one row per `(run_id, instrument_id)`: `final_alignment`,
  `computed_at`, the specific pivot/wave/pattern row ids it was derived from (for auditability).
- **`market_bars`** — supersedes relying on `market_bars_raw` for anything but daily; new table (or
  altered `market_bars_raw`) keyed `(instrument_id, interval, ts, provider)` — closes #23. Adjusted
  variant mirrors it with `adjustment_version`.
- **`swing_analysis_results`** — one row per `(run_id, instrument_id, hypothesis)` where
  `hypothesis in ('bullish','bearish')` — closes #15 by construction (never one shared row).
  Columns for: selected route, mandatory-gate results (jsonb keyed by gate id), confirmation-group
  results, vetoes, entry/stop/targets/reward-risk, final `analysis_action`.
- **`instrument_1h_bars`** — or reuse `market_bars` with `interval='1h'` — see above.

RLS: every new run-scoped table gets the same pattern already established in `0002_rls.sql`
(`status = 'completed' or role >= researcher`), joined through `screening_runs`. `instrument_direction`
and any "latest" view get their own policy since they're not run-scoped — SELECT only where the
backing run is `completed` (closes #6/#12 for Direction specifically).

## 5. File/module ownership (no two workstreams edit the same file concurrently)

| Workstream | Owns |
|---|---|
| Rules/provenance | `docs/swing-strategy-extraction.md`, new `strategies/buy-swing.yaml` / `strategies/sell-swing.yaml`, `strategies/shared-gates.yaml` additions (additive only) |
| Data/pipeline | `supabase/functions/run-screening/**` orchestration (`index.js`, new `pipeline/` subdir), `providers/fyers.js` (shared rate limiter), new NSE calendar module, migration `0006` (tables in §4 except analysis-specific ones) |
| Direction intelligence | `supabase/functions/run-screening/features/structure.js`, `wave.js`, new `patterns.js`, `direction.js` — algorithm only, not the HTTP/orchestration layer |
| Analysis engine | new `supabase/functions/run-screening/features/swing-analysis.js` (indicators, gates, routes, confirmations, risk/reward) |
| Database/security | migration `0006` DDL + RLS policies, storage lifecycle for chart objects, `app/src/middleware.ts` (next-redirect validation), `app/src/lib/auth.ts` extensions |
| Charts/frontend | `app/src/app/(app)/direction/**`, new `app/src/app/(app)/analysis/**`, `app/src/app/(app)/layout.tsx` (nav), `app/src/app/login/**` (redesign), new chart-rendering client components |
| QA/integration | all new `*.test.js`/`*.test.ts` files, `docs/release-checklist.md` |

Lead agent (this document) owns: this file, the migration *sequencing* decision, and conflict
resolution between workstreams.

## 6. Phased roadmap (dependency order)

1. **Phase 0 — Contracts (this document + swing-strategy-extraction.md).** In progress.
2. **Phase 1 — Safety/security fixes independent of the schema rebuild.** #27, #28 first (pure
   bug fixes, no schema dependency). Then #16 (ranking sum), #14 (wording), #18 (parameter
   labeling) — small, isolated, testable now.
3. **Phase 2 — Durable pipeline foundation.**
   - DONE: `supabase/migrations/0006_durable_pipeline_and_swing_analysis.sql` — leases
     (`screening_run_leases`, atomic acquire via single-row CAS + `expires_at` stale-lease
     recovery, replacing the non-atomic check from earlier this session), `pipeline_batches`,
     run-scoped Direction tables (`instrument_direction_runs`, `direction_pivots`,
     `elliott_hypotheses`, `pattern_detections`, `instrument_alignment`), `swing_analysis_results`
     + `swing_analysis_rule_traces`, interval-aware `market_bars_raw`/`market_bars_adjusted`
     (additive ALTERs, verified against the live schema's actual constraint names, not applied).
     Full RLS on every new table, same pattern as `0002_rls.sql`. **Not applied to the remote
     project.**
   - DONE: `supabase/functions/run-screening/nse-calendar.js` — `Asia/Kolkata` session timing,
     `latestCompletedNseSession()`, hourly bar boundaries with the disclosed
     `HOURLY_STUB_POLICY = "exclude"` decision, holiday list for 2026 (sourced from Zerodha's
     public calendar since nseindia.com's own page timed out on direct fetch — flagged as
     PROJECT_DEFAULT/unverified against the primary source, one entry explicitly flagged as
     anomalous and unconfirmed). 11 tests, all passing.
   - DONE: shared cross-invocation Fyers rate limiter (`providers/rate-limiter.js` +
     `provider_rate_limit_buckets`, migration `0007`) -- an atomic Postgres upsert-with-conditional-
     WHERE (`try_acquire_rate_limit_slot`), wired into `providers/fyers.js` as the authoritative
     guard alongside the existing in-memory pacer. Degrades gracefully (never blocks) if migration
     `0007` isn't applied yet.
   - DONE: atomic run-lease wired into `index.js`'s actual orchestration (`run-lease.js` +
     `screening_run_leases`) -- replaces the non-atomic select-then-insert check from earlier this
     session. Heartbeats every 25 instruments during the run; releases in a `finally` so a thrown
     error or a reconciliation failure never leaves the lease stuck. Degrades gracefully (acquires
     unconditionally) if migration `0006` isn't applied yet.
   - DONE: `getLatestRun` → published-run semantics (#12) -- new `getLatestPublishedRun()`
     (latest `status='completed'` run) now used by every content page (Buy/Sell signals, stock
     ledger, stock detail, Indexes, News); `getLatestRun()` (any status) stays scoped to Dashboard
     and Data health, which display the status prominently. Root cause was narrower than the
     spec's wording suggested: RLS already prevents a plain Viewer from ever seeing a non-completed
     run, so this specifically fixed Researcher+ roles.
   - DONE: `run_date` now uses `latestCompletedNseSession()` (Asia/Kolkata) instead of a plain UTC
     date slice (#22).
   - DONE: corporate-action-aware adjusted bars (#20) -- `features/corporate-actions.js`
     (`computeAdjustedBars`), a pure back-adjustment function for split/bonus actions (dividend
     adjustment is explicitly out of scope and disclosed as such -- no source document for its
     convention has been supplied). Wired into `index.js`, writing to `market_bars_adjusted`
     alongside the existing `market_bars_raw` write. Since `corporate_actions` has zero rows in
     production today, this is presently a structural no-op (adjusted == raw) until corporate-action
     data is actually ingested from somewhere -- **that ingestion is still unaddressed**, tracked as
     a remaining item below. Also fixed a regression this same work would otherwise have shipped:
     the `market_bars_raw` write now tries migration 0006's new shape first and falls back to the
     current live shape on any failure, so raw-bar ingestion doesn't break if the code deploys
     before the migration is applied.
   - REMAINING: corporate-action *data ingestion* (a source for `corporate_actions` rows -- the
     adjustment math above is ready, nothing feeds it), wiring `pipeline_batches` for true
     multi-invocation resumability (today's loop is still one long sequential pass within a single
     invocation, just no longer timing out the caller), multi-request historical backfill (>365
     days, needed for monthly MACD/Primary-degree Elliott per problem #8).
4. **Phase 3 — Direction intelligence rewrite.**
   - DONE: equal-pivot labels (#5) -- `labelPivotSequence` now emits explicit `EH`/`EL` for a
     within-tolerance repeat instead of folding it into `HH`/`HL` (which biased structure toward
     "bullish" on a mere retest). `direction_pivots.label`'s check constraint (migration 0006)
     already anticipated this.
   - DONE: unconfirmed-leg separation -- new `zigzagPivotsWithUnconfirmedLeg` (structure.js) exposes
     the current forming extreme without it becoming a confirmed pivot or entering
     `classifyDowStructure`'s input at all. Drawn distinctly on the chart (hollow, dashed, "H?"/"L?")
     so it can never be mistaken for a confirmed swing -- `charts/render.js` `RENDER_VERSION` bumped
     accordingly.
   - DONE: Elliott hypothesis engine substantially rewritten (`features/wave.js`) to address every
     specific defect the spec named: it now determines the actual current wave (forming vs.
     completed) at any point in the sequence instead of only ever recognizing a finished 6-pivot
     pattern and mislabeling it "wave 5 of 5"; a longer window failing a gate no longer hides a
     valid shorter one (wave 3 being the shortest only invalidates a *wave-5-done* claim, not
     waves 1-4); corrective (zigzag) readings now require a real structural shape check (B doesn't
     retrace past the origin of A, C extends beyond A) instead of accepting almost any 4 alternating
     pivots; output carries real rule arithmetic (actual computed numbers, not just booleans) and a
     real invalidation price+condition for waves 2/4 forming (the two waves with a hard-rule-derived
     invalidation -- 1/3/5 honestly have none documented); returns both a primary and, when
     applicable, an alternative hypothesis. Explicitly still out of scope: sub-wave (5-3-5) internal
     validation, flat/triangle/diagonal detection, multi-degree nesting -- these remain
     `MANUAL_REVIEW`-by-design, not silently guessed.
   - DONE: chart-hash completeness (#7) -- the hash now covers the full rendered bar window (not
     just the latest bar), the zigzag parameter, the algorithm version, and the chart renderer
     version, so a stored chart can no longer stay stale after an algorithm or renderer change with
     unchanged underlying pivots.
   - REMAINING: pattern detection (measurable patterns first, per spec -- not yet started), combining
     SMM + GUE + pattern evidence into a server-side `final_alignment` (#1, #6 -- the biggest
     remaining Phase 3 item), and actually persisting any of this into the new run-scoped schema
     (`instrument_direction_runs`, `direction_pivots`, `elliott_hypotheses`, `pattern_detections`,
     `instrument_alignment` -- migration 0006, still unapplied). Today's richer wave/unconfirmed-leg
     data flows through to the existing `instrument_direction` table and the rendered chart only.
5. **Phase 4 — Analysis engine.** Swing strategy YAML (from Phase 0's extraction) → indicators
   (DMI/ADX, EMA crossover series, Bollinger failure detection, divergence) → gates → routes →
   confirmations → BUY/WAIT, SELL/WAIT. Depends on Phase 3's `ALIGNED_BULLISH`/`ALIGNED_BEARISH`
   universe and Phase 2's 1-hour ingestion.
6. **Phase 5 — UI.** Direction table rebuild (server pagination, filters, lazy charts — #25),
   Analysis pages + multi-panel charts, nav/login/accessibility pass.
7. **Phase 6 — QA/integration.** The full test list from the spec, run against Phases 2-5's real
   code (not written against stubs).
8. **Phase 7 — Single verified push + live validation**, per the deployment authorization, only
   once Phases 1-6 are genuinely complete and passing.

## 7. Resolved decisions (strategy owner, 2026-09-10)

These three were blocking Phase 4 and have been decided:

1. **Reward/risk threshold.** New parameter `swing_minimum_reward_risk_strict: 3.0`, compared
   strictly (`reward/risk > 3.0`), scoped to the new swing (Weekly→Daily→1H) strategies only. The
   existing `minimum_reward_risk: 3.0` (compared `>=`) in `config/parameters.yaml`, used by the
   positional strategies, is untouched.
2. **Gate ID namespace.** New swing gates use `WBP-M1`..`WBP-M8` (buy) and `WSP-S1`..`WSP-S8`
   (sell) — distinct from the existing positional `BSP-`/`SSP-` IDs in
   `strategies/buy-signal-playbook.yaml` / `sell-signal-playbook.yaml`, so nothing collides.
3. **5 confirmation groups / 4-of-5.** The primary Weekly→Daily→1H playbooks (the authoritative
   source for *what* each route/gate checks — exact triggers, arithmetic, thresholds) use a
   100-point scorecard, not a "groups" structure; that structure exists only in the
   buy-conditions.md/sell-conditions.md cross-check docs. Resolution: the 5 groups are a disclosed
   `PROJECT_DEFAULT` synthesis layer this project defines, each populated from checks the primary
   playbook already documents per route (e.g. BUY-1's "quality" checks: wave-2 depth/alternation,
   hourly MACD crossover) — not new invented thresholds, not a claim the primary source states
   "groups" verbatim. Every group's membership must cite the real per-check source locator from
   `swing-strategy-extraction.md`. The 4-of-5 pass threshold is this project's own gating rule,
   versioned as such.

## 8. Open decisions for the strategy owner (cannot be resolved by an agent)

- Whichever conflicts `docs/swing-strategy-extraction.md` surfaces between the Weekly→Daily→1H
  playbook and the buy-conditions/sell-conditions references.
- Item #17 (draft rules in production) needs a decision on whether to deactivate them now (may
  change current dashboard output) or gate them behind a feature flag first.
- NSE holiday calendar source: is there a licensed/official source already available, or does this
  need a maintained static list (versioned, with a documented update process)?
- Reward/risk threshold: spec says swing strategies must use strict `> 3.00` as a
  *strategy-specific* versioned decision, distinct from the existing `minimum_reward_risk: 3.0`
  in `config/parameters.yaml` used by other strategies — confirm this should be a new parameter
  key (e.g. `swing_minimum_reward_risk_strict`) rather than changing the shared one.

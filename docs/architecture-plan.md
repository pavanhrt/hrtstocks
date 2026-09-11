# Direction/Analysis rebuild — lead-agent architecture plan

Status: **Phase 3 (Direction intelligence rewrite) — complete; Phase 2 (durable pipeline) — 1-hour
bar ingestion built, gated behind Phase 4's direction lock; Phase 4 (Analysis engine) — weekly+daily
direction lock (WBP-M1..M4/WSP-S1..S4) done and persisted, plus 2 of 10 hourly routes (BUY-1/SELL-3
"Wave 3 Ignition", BUY-4/SELL-4 "Wave 2 Pullback"/"Bounce Failure") detected end-to-end; 6 remaining
routes, the confirmation groups, most vetoes, and reward/risk are still REMAINING; Phase 5 (UI) —
the Analysis page, the Direction table rebuild, and the nav/login/accessibility pass are all done
and live; Phase 6/7 (QA/integration, deploy) not started.** Phases 0-3
(contracts, safe-redirect/error-handling/UI-copy fixes, durable pipeline/corporate-actions/
rate-limiting/run-locking, and the Direction rewrite itself -- equal-pivot labels, unconfirmed-leg
separation, the Elliott engine rewrite, pattern detection, server-side `final_alignment`, and
run-scoped persistence) are done. Phase 4 so far: `strategies/buy-swing.yaml`/`sell-swing.yaml`
(gates WBP-M1..M8/WSP-S1..S8, M1-M4/S1-S4 automated) plus `features/swing-analysis.js`, turning
those gate traces into a real `swing_analysis_results` row per hypothesis every run, and
`features/hourly-routes.js`'s `detectWave3Ignition`/`detectWave2Pullback`, whose evidence now flows
into that same row's `selected_route`/`route_evidence` -- `final_action` stays `WAIT` regardless
(`WBP-M5`/`WSP-S5` needs all 5 routes ruled in/out, not just the two implemented), with the specific
blocking reason disclosed in `pending_conditions` rather than a guessed BUY/SELL. Phase 2 now
fetches and stores 1-hour bars (`providers/fyers.js`'s `fetchHourlyOHLCV`, `nse-calendar.js`'s
`normalizeHourlyBars`, `index.js`'s `ingestHourlyBarsAndDetectRoutes`), gated on
`directionLockPassed()` so it only spends request budget on instruments that have actually cleared
M1-M4/S1-S4 -- no longer a no-op: `buy-swing.yaml`/`sell-swing.yaml` were seeded to the live project
on 2026-09-10 (see below). All of the above is locally committed on `develop`; see each phase's
DONE/REMAINING bullets in §6 below.

**Live-application update (2026-09-10, superseding this document's original "nothing applied"
status below and throughout §6/§4):** migrations `0006_durable_pipeline_and_swing_analysis.sql` and
`0007_provider_rate_limit_buckets.sql` are both applied to the live project (`yqxpucjtzrmwjniruebt`);
`buy-swing-playbook`/`sell-swing-playbook` (parameter version `1.2.0`) are seeded and active; the
`run-screening` Edge Function is deployed (via the Supabase CLI, `index.js` renamed to `index.ts` for
the CLI's hardcoded entrypoint convention) and has completed real runs against live Fyers data. Two
real production bugs were found and fixed this way that no amount of local/mocked testing had
caught: `screening_run_leases.run_id` had a foreign-key constraint that made every lease acquisition
fail (acquireRunLease runs before its own run's `screening_runs` row exists by design -- constraint
dropped, `run_id` is informational only); and the time-budget-skip path's ~490 sequential
single-row inserts could themselves outlast the platform's own wall-clock kill, leaving a run stuck
`running` forever with the lease never released (fixed: bulk-insert the skip path once the budget is
first exceeded, since the clock only moves forward). Real, verified coverage today is still low --
about 13-18 of 501 instruments get actual Fyers data per run, the rest hit the time budget and are
recorded `NO_DATA`/`unavailable` -- root-caused to ~20 sequential per-instrument Supabase round trips
in a single invocation; concurrency was added for the genuinely-independent ones (the 3 Direction
timeframes, direction-analysis vs. rule-evaluation, raw vs. adjusted bars), cutting it to ~13-14 and
improving coverage from 13 to 18, but the real ceiling fix -- `pipeline_batches` multi-invocation
resumability (sketched in §4, never wired up) or instrument-level concurrency in the main loop -- is
still REMAINING and deliberately not started (flagged to, and held back by, the project owner
pending a decision on priority).

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
direction_state:         uptrend_intact | downtrend_intact | sideways
                          | confirmed_reversal_bullish | confirmed_reversal_bearish
                          | ambiguous | manual_review | unavailable
                          (corrected from this doc's own original draft -- sideways_range/mixed --
                          to match structure.js's classifyDowStructure, which is pre-existing,
                          tested, working code and therefore authoritative over a draft vocabulary
                          written before it was reconciled against; migration 0006's
                          instrument_direction_runs.dow_state check constraint corrected to match)
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
   - DONE: 1-hour bar ingestion, scoped and gated. `providers/fyers.js`'s new
     `fetchHourlyOHLCV(instrumentId, symbol, supabase, days)` (`resolution=60`, `date_format=0`
     epoch-second range bounds -- unlike `fetchOHLCV`'s `date_format=1`, an intraday resolution
     needs a boundary finer than a calendar day). `HOURLY_LOOKBACK_DAYS = 15` (a disclosed
     `PROJECT_DEFAULT`): the swing playbooks only ever reason about a handful of recent hourly
     candles (BUY-3/SELL-2's own documented floor is "fifteen to twenty hourly candles" --
     swing-strategy-extraction.md §2), not a long history like daily bars need for EMA-200/MACD
     warmup, so 15 calendar days (~60-66 hourly candles) gives comfortable margin over that floor
     while staying far under any plausible Fyers intraday date-range cap -- deliberately avoiding
     the need to know that cap's exact value, since (unlike `OHLCV_LOOKBACK_DAYS`'s 366-day cap,
     confirmed via a live 422 response) **neither `resolution=60` nor `date_format=0` has been
     confirmed against a live Fyers response in this environment** (no `FYERS_ACCESS_TOKEN`
     available) -- flagged for empirical verification once a token is configured, before relying on
     this in production.
     `nse-calendar.js`'s new `normalizeHourlyBars()` converts raw epoch-timestamped candles into
     this project's bar shape, keeping only candles whose IST start-of-bar time matches one of
     `hourlyBarBoundaries()`'s 6 windows -- this is what actually implements
     `HOURLY_STUB_POLICY=exclude` (a 15:15-started stub candle simply fails the boundary match,
     regardless of whether Fyers even returns one), and marks the still-forming current hour as
     `is_complete=false` by comparing each bar's own end-instant against `now`. Assumes Fyers
     timestamps an intraday candle by its START (matching this project's own confirmed convention
     for daily candles) -- also unconfirmed live; if wrong, every candle fails its boundary match
     and this returns an empty list, a safe failure (no hourly bars, i.e. `NO_DATA` upstream), never
     a wrong or mislabeled bar.
     Wired into `run-screening/index.js`'s new `ingestHourlyBars`, called once per instrument
     **only when `features/swing-analysis.js`'s new `directionLockPassed()` is true for either
     hypothesis** -- both playbooks state explicitly "M1 AND M2 AND M3 AND M4 must all pass before
     the hourly chart is opened," so this spends Fyers request budget only on instruments that have
     actually cleared the weekly+daily direction lock, not all ~500 every run (which the existing
     125s time budget and rate limits could not absorb). Writes `market_bars_raw` with
     `interval='1h'` (migration 0006) -- deliberately has **no old-schema fallback** (unlike the
     daily write above): the pre-migration unique constraint `(instrument_id, session_date,
     provider)` doesn't include `interval`, so an hourly bar would collide with and silently corrupt
     that same day's daily bar under the old shape; failing outward (caught by the caller, logged,
     no hourly data for that instrument this run) is the only safe behavior pre-migration.
     Real effect today is a no-op: `buy-swing.yaml`/`sell-swing.yaml` aren't seeded, so
     `directionLockPassed` is always false and `ingestHourlyBars` never runs -- the infrastructure is
     real and tested, but nothing actually fetches hourly data until those strategies are seeded
     (a remote write, not done per this task's constraints).
     Tests: 4 new cases in `nse-calendar.test.js` for `normalizeHourlyBars` (stub exclusion,
     off-boundary rejection, mid-session completeness, empty input), 3 new cases in
     `swing-analysis.test.js` for `directionLockPassed`. No test added for `fetchHourlyOHLCV` itself
     (network I/O, same as the pre-existing `fetchOHLCV` -- untested for the same reason).
   - DONE (2026-09-11, "Correction Cycle 1" — see §9 below): `pipeline_batches` multi-invocation
     resumability, and multi-request historical backfill (5-year target, >365 days, for monthly
     MACD/Primary-degree Elliott per problem #8).
   - REMAINING: corporate-action *data ingestion* (a source for `corporate_actions` rows -- the
     adjustment math above is ready, nothing feeds it; separately, whether Fyers' own history API
     already returns split/bonus-adjusted prices is itself UNRESOLVED, see §11).
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
   - DONE: pattern detection (`features/patterns.js`), scoped per the spec's own instruction --
     "implement measurable patterns first, keep subjective/unresolved patterns under manual review."
     Implemented against swing-strategy-extraction.md §12's DOCUMENTED/exact-or-disclosed-tolerance
     entries only:
     - Candlestick (§12.1, `detectCandlestickPatterns`): Bullish/Bearish Engulfing, Bullish
       Piercing/Bearish Dark Cloud Cover (exact median-of-body rule), Hammer/Shooting Star/Hanging
       Man (exact 2x-wick-vs-body rule; the opposite-side wick cap is the source's own disclosed
       ~0.6x approximation, versioned as `HAMMER_UPPER_WICK_CAP_FRACTION`), Morning/Evening Star
       (exact 3-candle rule). Hanging Man and Dark Cloud Cover both require the source's documented
       follow-through candle before being `TRIGGERED`, staying `OBSERVED` until then.
     - Chart formation (§12.2, `detectDoubleExtremePatterns`): Double Top/Double Bottom from the
       already-labeled pivot sequence, using the source's own disclosed ~3% comparability tolerance
       (`DOUBLE_EXTREME_TOLERANCE`) and requiring the documented prior trend into the first extreme
       so a plain new HH/LL is never misread as a double top/bottom.
     - Every threshold this module invents at all (wick cap, extreme tolerance, prior-trend lookback
       window) is a disclosed `PROJECT_DEFAULT`, versioned via `PATTERN_PARAM_VERSION` and recorded
       in each detection's `source_locator`.
     - Deliberately NOT implemented -- the source itself never resolves these to a number, so
       detecting them would mean inventing a threshold: Head & Shoulders / Inverted H&S / Cup &
       Handle (§12.2, more anchor points than Double Top/Bottom and no simpler to approximate
       honestly), Bull/Bear Flag & Pole (§12.3 -- the source explicitly flags this as "the rule that
       disqualifies most candidates" with zero numeric guidance), Doji family, Spinning
       Top/Harami/High Wave, all PAPA formations except the already-DOCUMENTED ones not yet wired
       (Accumulation/Distribution, Tweezers, Gap-sustain, Rounding bottom/top -- all §12.4
       UNRESOLVED). None of these produce a row; their absence means "not evaluated," not "not
       present" -- callers must not treat a stock with no pattern rows as pattern-clean.
     - Wired into `run-screening/index.js`: `persistPatternDetections` runs per instrument/timeframe
       right after the direction chart/row upsert, inserting into `pattern_detections` (migration
       0006, still unapplied -- degrades gracefully on `PGRST205` exactly like the other new-schema
       writes in this file). Unlike `instrument_direction`, this is a plain INSERT of fresh per-run
       evidence, not an upsert keyed on a hash -- a pattern can newly qualify (e.g. one more bar
       closes an engulfing pair) even when the underlying pivot structure hasn't changed.
     - Tests: `features/patterns.test.js`, 13 cases covering trigger conditions, the documented
       prior-trend/location requirement for each single/multi-candle pattern, the follow-through
       requirement for Hanging Man/Dark Cloud Cover, and the double-extreme tolerance/prior-trend
       gate (including a rejection case for a pair outside tolerance).
   - DONE: server-side `final_alignment` (#1, #6) -- new `features/alignment.js`,
     `computeFinalAlignment(direction, patternsByTimeframe)`. A disclosed `PROJECT_DEFAULT` synthesis
     (no source document defines how to combine three timeframes' verdicts + a wave hypothesis +
     pattern evidence into one instrument-level call, only a per-chart weighting in
     `smm-chart-analysis-SKILL.md` §7 -- "primary trend > position vs level > structure break >
     candle patterns > volume"), versioned via `ALIGNMENT_LOGIC_VERSION` and reasoned as follows:
     - **SMM is the only source of a directional call.** `ALIGNED_BULLISH`/`ALIGNED_BEARISH` require
       all three of daily+weekly+monthly `dow_state` to independently agree -- the same requirement
       `DirectionTable.tsx`'s client-side `confluenceOf()` already used (problem #1's actual bug was
       *where* this ran and *how completely*, not the core rule), now authoritative and computed
       server-side.
     - **GUE is disclosed, never authoritative.** A confirmed wave impulse on a timeframe can never
       actually disagree with that timeframe's own `dow_state` (both derive from the same pivot
       sequence), so there's no sound basis for it to independently veto/confirm here -- consistent
       with `AGENTS.md` already treating Elliott counting as `MANUAL_REVIEW`-by-design.
     - **PAPA can downgrade to `MANUAL_REVIEW`, never flip the call outright** -- a `TRIGGERED`
       (never merely `OBSERVED`) pattern opposing the SMM-determined direction, on any of the three
       timeframes, matches the source's own "reversal signal ends trend validity" framing closely
       enough to require a human look, not closely enough (alone) to declare the opposite trend.
     - **Missing timeframe coverage never becomes a directional pass** -- 0 resolved timeframes is
       `UNAVAILABLE`; 1-2 is `MANUAL_REVIEW`, never evaluated as if it were a complete set.
     - Wired into `run-screening/index.js`'s `persistFinalAlignment`, called once per instrument
       after all three timeframes' direction+pattern work: upserts `instrument_alignment`
       (migration 0006, not yet applied -- degrades gracefully). `monthly/weekly/daily_direction_id`
       and `elliott_hypothesis_id` are deliberately left null (nothing in this pipeline writes
       `instrument_direction_runs`/`elliott_hypotheses` yet -- populating them now would mean
       inventing ids); `triggered_bearish_pattern_id`/`triggered_bullish_pattern_id` are populated
       from the real `pattern_detections` insert id only when the row count of that insert matches
       the computed hits 1:1, otherwise left null rather than risk mis-attributing one. Migration
       0006 itself was corrected in passing: it only ever had `triggered_bearish_pattern_id`
       (an asymmetric oversight from when it was drafted before pattern detection existed) --
       added the matching `triggered_bullish_pattern_id` column, safe since the migration is still
       unapplied.
     - Tests: `features/alignment.test.js`, 10 cases -- all-bullish/all-bearish/all-sideways
       agreement, cross-timeframe disagreement (`MIXED`), zero/partial timeframe coverage
       (`UNAVAILABLE`/`MANUAL_REVIEW`), a `TRIGGERED` opposing pattern downgrading both bullish and
       bearish calls, an `OBSERVED` (not `TRIGGERED`) opposing pattern *not* downgrading, and an
       agreeing `TRIGGERED` pattern not downgrading.
   - DONE: run-scoped direction/wave persistence -- new `persistDirectionRun` in
     `run-screening/index.js`, called once per instrument/timeframe alongside (not instead of) the
     legacy `instrument_direction` upsert, which remains what the live Direction page reads until
     Phase 5's UI rebuild switches it over.
     - `instrument_direction_runs`: this run's own immutable snapshot (`confirmed_pivots`,
       `unconfirmed_leg`, `dow_state`, chart path/hash/algorithm-version/renderer-version),
       upserted on `(run_id, instrument_id, timeframe)`. `trend_defining_level` and
       `invalidation_level` are both set to `lastSwingLow` (bullish states) /
       `lastSwingHigh` (bearish states) -- `smm-chart-analysis-SKILL.md` names the last HL/LH as
       *the* trend-defining level and separately describes invalidation for a bullish view as a
       close below that same level, so the source itself treats these as one number for an
       intact/confirmed trend. `confirmation_trigger` is deliberately left null: no document in
       this project defines a deterministic confirmation-trigger level (the source gives a live
       example -- "weekly close above 24,800" -- not a formula), so computing one would mean
       inventing it.
     - `direction_pivots`: one row per confirmed swing, in sequence. The unconfirmed leg is
       deliberately NOT duplicated here -- it has no honest `HH`/`HL`/`LH`/`LL`/`EH`/`EL` label yet
       (that's what "unconfirmed" means), so forcing it into this table's label enum would mean
       inventing a label; it stays in `instrument_direction_runs.unconfirmed_leg` only.
     - `elliott_hypotheses`: primary + alternative rows, but only when `wave.js` actually returned a
       structured hypothesis (`structureType` non-null) -- the "nothing to report" placeholder
       object never produces a row, matching this project's "never invent" discipline rather than
       storing a fabricated empty hypothesis.
     - Corrected an inconsistency found while wiring this up: migration 0006's
       `instrument_direction_runs.dow_state` check constraint used placeholder values
       (`sideways_range`, `mixed`) from this document's own original status-vocabulary draft,
       written before `structure.js`'s pre-existing, tested `classifyDowStructure()` was reconciled
       against it -- that function actually returns `sideways`/`ambiguous`. Corrected both the
       migration (safe, still unapplied) and this document's §3 status vocabulary to match the real,
       working code rather than the earlier draft.
     - Not unit-tested directly (like `upsertDirectionAnalysis`/`persistFinalAlignment`, it's thin
       DB-glue over already-tested pure modules -- `structure.js`, `wave.js`, `direction.js` each
       have their own suites); verified via `npm test` (162/162 unchanged) + `npm run build`.
5. **Phase 4 — Analysis engine.** Swing strategy YAML (from Phase 0's extraction) → indicators
   (DMI/ADX, EMA crossover series, Bollinger failure detection, divergence) → gates → routes →
   confirmations → BUY/WAIT, SELL/WAIT. Depends on Phase 3's `ALIGNED_BULLISH`/`ALIGNED_BEARISH`
   universe and Phase 2's 1-hour ingestion.
   - DONE: the weekly+daily direction lock -- new `strategies/buy-swing.yaml` /
     `strategies/sell-swing.yaml`, gates `WBP-M1..M8` / `WSP-S1..S8` (namespaced per §7 decision 2,
     reusing the existing `evaluateRules`/expression-engine infrastructure `strategies/buy-signal-
     playbook.yaml` already established -- no new evaluation engine needed).
     - `WBP-M1..M4`/`WSP-S1..S4` are real, automated, `DOCUMENTED` gates (a first for this
       namespace -- the positional `BSP-M2/M4A/M5/M6/M8` equivalents all stayed `MANUAL_REVIEW`
       sentinels): weekly Dow direction, weekly Elliott position, daily Dow direction (+ no live
       `TRIGGERED` opposing daily pattern), and daily wave position + MACD Tide agreement. Per both
       playbooks' own explicit rule ("M1 AND M2 AND M3 AND M4 must all pass before the hourly chart
       is opened"), these four gates are a complete, self-contained, honestly-scoped slice that
       needs no 1-hour data at all.
     - `WBP-M5..M8`/`WSP-S5..S8` (hourly Elliott setup, PAPA trigger, SMM Hat, reward/risk) are
       `MANUAL_REVIEW` sentinels, same pattern as `BSP-M5/M6/M8` -- but disclosed as
       data-availability blocks (no 1-hour bars ingested yet, Phase 2 REMAINING), not
       specification gaps like `BSP-M5`'s. `WBP-M7`/`WSP-S7` (SMM Hat) are additionally blocked on
       an open strategy-owner decision (`swing-strategy-extraction.md` §13 conflict #11, Step 2
       crossover choice underspecified for the hourly variant).
     - `hard_gate: false` on every WBP-/WSP- rule, for the identical cross-strategy-pooling reason
       already documented on `BSP-M1`'s own note (`evaluateRules()`/`classify()` pool hard-gate
       failures across every active strategy with no direction scoping) -- a future `/analysis` page
       (Phase 5) must read `WBP-*`/`WSP-*` traces directly and apply the AND of M1-M4 itself,
       exactly like `buy-signals`/`sell-signals` already do for `BSP-*`/`SSP-*`.
     - `WBP-M2`/`WSP-S2` (weekly Elliott position) is a disclosed interpretation, not a literal
       transcription, of `swing-strategy-extraction.md` §4's compressed table cells -- flagged
       explicitly in each rule's own `note` field (e.g. `WSP-S2`'s 3-branch reading of "a completed
       5-up" as a completed bullish impulse setting up a reversal). Not resolved as a strategy-owner
       decision here; disclosed so it can be checked against the fuller source table later.
     - Supporting engine work: `features/wave.js`'s hypothesis objects (impulse and zigzag) now carry
       an explicit `direction: 'bullish'|'bearish'` field (previously only encoded inside the
       human-readable `label` string) -- needed by `WBP-M2/M4`/`WSP-S2/S4` to know which way a
       structure points without string-parsing. `features/context.js` now also computes
       `daily_dow_state` (previously only weekly/monthly were classified for rule evaluation --
       direction.js computed a daily dow_state, but only for the Direction feature, never fed into
       `evaluateRules`), `{weekly,daily}_elliott_*` (reusing `structure.js`'s `labelPivotSequence` +
       `wave.js`'s `labelWave`, the same engine the Direction feature uses), and
       `daily_no_live_triggered_{bullish,bearish}_pattern` (reusing `features/patterns.js`'s
       detectors directly on daily bars).
     - New `strategies/buy-swing.yaml`/`sell-swing.yaml` registered in
       `supabase/seed/parse-strategies.mjs`'s `STRATEGY_FILES`, verified via `parseStrategyFile()`
       (8 rules each, 0 skipped, valid syntax) -- **not seeded to the remote project** (seeding
       writes `rule_definitions`/`strategy_versions` to the live database, prohibited without
       explicit authorization per this task's constraints, same as the unapplied migrations).
     - Tests: `rules/swing-gates.test.js` (9 golden-case tests, one per real gate plus a
       missing-input/NO_DATA case, expressions verified to match the seeded YAML text exactly, not
       just hand-copied), plus new coverage in `wave.test.js` (direction field) and
       `context.test.js` (5 new cases for `daily_dow_state`, weekly/daily Elliott position, and the
       pattern-veto booleans).
   - DONE: `swing_analysis_results`/`swing_analysis_rule_traces` persistence -- new
     `features/swing-analysis.js`, `evaluateSwingHypothesis(hypothesis, traces)`: filters the
     already-pooled `evaluateRules()` trace array to its own `WBP-`/`WSP-` prefix, producing one
     row per hypothesis (never pooled, closing problem #15 for the swing side too) with
     `mandatory_gates` populated for all 8 gates (M1-M4's real PASS/FAIL/NO_DATA, M5-M8's
     MANUAL_REVIEW), `data_quality` derived from whether the 4 direction-lock gates actually
     resolved, and `final_action` **always `WAIT`** -- since `WBP-M5..M8`/`WSP-S5..S8` can never
     resolve to PASS yet, this module has no honest basis to claim BUY/SELL, and says exactly why in
     `pending_conditions` (which direction-lock gate failed or lacked data, that the hourly gates are
     blocked on missing 1-hour ingestion, and that route selection/confirmation groups/vetoes/
     reward-risk aren't computed here at all) rather than silently omitting the reason. Returns
     `null` (not a fabricated NO_DATA row) when neither hypothesis has any swing-gate traces at all
     -- today's actual state, since `buy-swing.yaml`/`sell-swing.yaml` aren't seeded yet.
     Wired into `run-screening/index.js`'s `persistSwingAnalysisResults`, called once per instrument
     right after the existing `rule_traces` insert: upserts `swing_analysis_results` per
     `(run_id, instrument_id, hypothesis)`, then delete-then-inserts that result's own
     `swing_analysis_rule_traces` (idempotent against an unexpected re-evaluation within one run).
     Degrades gracefully (migration 0006 not yet applied). 7 new tests in
     `features/swing-analysis.test.js`.
   - DONE: BUY-1 "Wave 3 Ignition" / SELL-3 "Wave 3-Down Ignition" route detection -- new
     `features/hourly-routes.js`, `detectWave3Ignition()`. Picked as the first (of ten) hourly
     Elliott routes to implement because the source itself calls BUY-1 "the flagship" and SELL-3
     "the mirror of the flagship buy" (`swing-strategy-extraction.md` §2/§3) -- the most completely
     documented pair. Implements the three REQUIRED checks (rule-1 arithmetic is inherited for free
     from `wave.js`'s own impulse validation):
     - **Trigger (check 6)**: the first hourly close after wave 2's own bar that clears wave 1's
       price. The gap/first-candle rule (§9, an explicitly undocumented choice between two
       alternatives) is resolved here as the disclosed `PROJECT_DEFAULT` "measure against the
       previous session's close": a first-candle-of-the-session trigger only counts if the prior
       session's own daily close had already cleared wave 1 -- otherwise it's `gapOnly` and not
       `confirmed`.
     - **Volume (check 7)**: the trigger candle must clear its own hour-slot average (new
       `hourSlotAverageVolume()` in `features/indicators.js`, averaging only PRIOR sessions'
       same-hour-of-day volume -- never the target session or a later one), AND wave 3's
       volume-so-far must exceed wave 1's own summed volume.
     - **Rule-3 forward-check (check 8)**: the minimum viable wave-3 target (end of wave 2 +/- the
       length of wave 1) must sit at/beyond the nearest daily resistance/support (`structure.js`'s
       `zigzagPivots()` on daily bars) -- auto-passes when no such daily level exists above/below
       the current price at all.
     - Deliberately NOT computed: BUY-1's "quality" (non-required) checks -- wave-2 depth/
       alternation, hourly MACD PCO -- same reasoning as the M1-M4 gates' own scope note (they only
       ever grade an already-valid setup, never gate it). BUY-2..5/SELL-1,2,4,5 are NOT implemented
       -- a non-match from this module does NOT mean "no hourly setup exists," only that this one
       route doesn't currently apply; `WBP-M5`/`WSP-S5` stay `MANUAL_REVIEW` accordingly (their
       `note` fields updated to say so precisely).
     - `labelWave()` is called with the target direction (`bullish` ? "uptrend_intact" :
       "downtrend_intact") supplied directly, NOT derived from `classifyDowStructure()` on the
       sparse hourly pivot set -- a fresh wave-3-forming shape is inherently only 3 confirmed
       pivots deep (origin + wave 1 + wave 2), exactly the case `classifyDowStructure()` calls
       `"ambiguous"` (it needs 2+ confirmed highs AND 2+ confirmed lows to say anything else). This
       module is testing one specific directional hypothesis, not asking "what is this hourly
       chart's general trend" -- the same pattern `wave.test.js`'s own fixtures already use.
     - `features/wave.js`'s hypothesis objects now also carry `pivotPrices` (the actual labeled
       pivots a hypothesis is built from, oldest-first) -- needed to check a documented trigger
       level (e.g. "close above the high of wave 1") rather than just the wave-position label; a
       small, additive extension, not a redesign.
     - `HOURLY_LOOKBACK_DAYS` (`providers/fyers.js`) revised from 15 to 30 calendar days once the
       hour-slot volume check needed `hour_slot_volume_lookback_sessions` (15, see below) PRIOR
       trading sessions of history, not just the 15-20 hourly candles the pivot-finding floor
       needed.
     - Two new documented parameters in `config/parameters.yaml` (bumped to `parameter_version
       1.2.0`): `zigzag_hourly_pct: 0.0125` (midpoint of the source's stated "1-1.5% hourly" range)
       and `hour_slot_volume_lookback_sessions: 15` (midpoint of "10-20 sessions").
     - New `route_evidence jsonb` column on `swing_analysis_results` (migration 0006, still
       unapplied -- safe to extend): the full trigger/volume/rule-3-forward-check evidence, not
       just the pass/fail verdict `selected_route` implies. Wired into
       `run-screening/index.js`'s `ingestHourlyBarsAndDetectRoutes` (runs route detection right
       after the hourly bars it just fetched, no extra DB round-trip) and
       `persistSwingAnalysisResults` (folds a detected route into `selected_route` +
       `pending_conditions`, but never flips `final_action` off `WAIT` -- `WBP-M5`/`WSP-S5` still
       needs all 5 routes ruled in/out, not just this one).
     - Tests: `features/hourly-routes.test.js` (8 cases -- no-shape-present, a fully-passing setup,
       no-trigger-yet, gap-only vs. genuinely-cleared first-candle triggers, a volume-check
       failure, a rule-3-forward-check failure, and the bearish/SELL-3 mirror), 3 new cases in
       `features/indicators.test.js` for `hourSlotAverageVolume`, 2 new `pivotPrices` assertions in
       `wave.test.js`.
   - DONE: BUY-4 "Wave 2 Pullback" / SELL-4 "Bounce Failure" route detection -- new
     `detectWave2Pullback()` in `features/hourly-routes.js`. Picked as the second route because
     BUY-4/SELL-4 are a genuine structural mirror pair (a counter-trend retracement into the
     38.2-61.8% Fibonacci band of the prior leg, failing there on a reversal trigger, resuming the
     dominant trend) and, unlike `BUY-2`'s ambiguous "wave-4 high" trigger text (see this file's own
     scope note on why `BUY-2` was skipped), its required conditions are unambiguous. Reuses
     `wave.js`'s wave-2-forming detection (same `currentWave`/`waveState` pattern
     `detectWave3Ignition` already established, one wave earlier) plus, newly, `features/patterns.js`'s
     candlestick detectors for the required PAPA-trigger check ("a bullish/bearish reversal trigger
     prints at that Fibonacci level") -- the first cross-use of the pattern-detection engine outside
     the Direction feature it was originally built for.
     - `wave.js`'s own `ruleArithmetic` doesn't cover a still-*forming* wave 2 (it only computes
       `wave2RetracementFraction` once wave 2 is a *confirmed* pivot, i.e. wave 3 has begun) -- this
       module computes the retracement fraction itself from the live `unconfirmedLeg` extreme, and
       separately checks it hasn't breached wave 1's own origin.
     - `SELL-4`'s own extra "wave b may not exceed 78% of wave a" structural check (its check 6)
       needed no separate code: the 38.2-61.8% Fib band the shared check already enforces is
       strictly tighter than 78%.
     - Stops are computed as documented per side, not forced into a shared shape: `BUY-4`'s is
       "below the origin of wave 1" (the whole impulse's own start); `SELL-4`'s is "above the rally
       high" (the bounce's own peak) -- a materially different, much tighter stop, a real asymmetry
       in the source text, not an implementation inconsistency.
     - `index.js`'s `ingestHourlyBarsAndDetectRoutes` now runs every implemented detector per
       hypothesis and collects an array (`routeEvidence.bullish`/`.bearish`), since a hypothesis
       could in principle match more than one detector as more routes are added (today at most one
       ever does, since a wave hypothesis can only be in one Elliott position at once).
       `persistSwingAnalysisResults` picks the first `requiredChecksPassed` route (if any) as
       `selected_route`, and discloses every detected-but-unconfirmed route in `pending_conditions`
       too, not just the passing one.
     - Tests: 6 new cases in `hourly-routes.test.js` (no-shape-present, a fully-passing setup, a
       breached-origin failure, a too-shallow-retracement failure, an in-band-but-no-trigger
       failure, and the bearish/`SELL-4` mirror).
   - REMAINING: BUY-2, BUY-3/SELL-2 (Ending Diagonal Reversal/Breakdown), BUY-5/SELL-5
     (Continuation Add), SELL-1 (Wave 5 Exhaustion) -- 6 of the 10 hourly routes -- `WBP-M6..M8`/
     `WSP-S6..S8` (PAPA trigger, SMM Hat, reward/risk -- all still blocked, M7/S7 additionally on
     the open §13 conflict #11 decision), the 5 confirmation groups (§7 decision 3), vetoes (the
     "what kills a live signal" list -- two of its ~11 items, "daily close below the last HL" and
     "weekly MACD histogram downticking," are NOT hourly-dependent and could be automated before
     the rest; left undone to avoid a half-implemented `vetoes` array that would look like "no
     vetoes triggered" rather than "vetoes not yet computed"), the 15-minute-stub rule's own
     `PROJECT_DEFAULT` (§10, `HOURLY_STUB_POLICY` already resolved this for chart rendering, not
     yet cross-checked against this route-detection use), and DMI/ADX (still uncomputed -- no gate
     needs it yet).
6. **Phase 5 — UI. DONE (2026-09-10), all three items:**
   - DONE: **Analysis page** (`app/src/app/(app)/analysis/page.tsx`, `lib/data/swing-analysis.ts`)
     -- the `/analysis` page this section's own §5 note anticipated ("a future `/analysis` page
     (Phase 5) must read `WBP-*`/`WSP-*` traces directly and apply the AND of M1-M4 itself"). Reads
     `swing_analysis_results` directly rather than re-deriving from pooled `rule_traces` the way
     `buy-signals`/`sell-signals` must for `BSP-*`/`SSP-*` -- `evaluateSwingHypothesis()` already
     applied that AND server-side when the row was written, since WBP-/WSP- rows are never pooled
     (problem #15 doesn't apply to them). One page, Bullish and Bearish sections: real M1-M4
     direction-lock results, M5-M8 honestly labeled `MANUAL_REVIEW`, any detected route, and
     `final_action` -- always `WAIT` today (Phase 4's M5-M8/routes/confirmations/vetoes/reward-risk
     are still REMAINING per §6.5 above), with a per-stock expandable list of exactly which
     `pending_conditions` are still open rather than a bare unexplained WAIT.
   - DONE: **Direction table rebuild** (server pagination, filters, lazy charts — #25), plus closing
     #1 and #6 in the same pass. `lib/data/direction.ts`'s `getDirectionPage()` reads
     `instrument_alignment.final_alignment` (server-computed by `features/alignment.js`, closing #1
     -- no confluence logic left in the browser) joined to `instrument_direction` **scoped to the
     same single `run_id`** throughout (closing #6 -- the old query had no run_id filter at all, so a
     stale timeframe row from an older run could silently mix with fresh ones). Real server-side
     pagination (25/page, `.range()` + exact count), search (`symbol`/`name` `ilike` via `.or()` with
     `referencedTable`), and confluence filtering, all pushed into the query -- chart signed URLs are
     now only ever requested for the current page's rows, closing #25 as a direct consequence rather
     than a separate mechanism. New `DirectionControls.tsx` (client) drives `?q=`/`?alignment=` on the
     URL. The stock detail page's existing 3-panel timeframe view (chart + dow_state + wave label per
     timeframe -- this section's own "multi-panel charts" item, already built pre-Phase-5) was
     switched onto the same run_id-scoped `getDirectionForInstrument()` and now also shows
     `final_alignment`.
   - DONE: **nav/login/accessibility pass** (#29, #30). New `Nav.tsx` (client, needs `usePathname`)
     replaces the flat `<Link>` row: `aria-current="page"` + an active-link underline, and a
     hamburger toggle collapsing the links into a dropdown under 860px (#29). #30 was flagged as
     "needs a real browser pass," not confirmed broken -- that pass found contrast already passes
     WCAG AA everywhere measured (input text 21:1, dim text 5.8:1, placeholder ~4.6:1), so no color
     changes were needed; the real gap was labeling (`placeholder` as the only label, which
     disappears once the user types) -- added a real `<label htmlFor>` above every field across all
     three login forms, plus `role="status" aria-live="polite"` around the error/notice region.
     Noticed but deliberately not touched: a pre-existing dev-console warning telling `LoginForm` to
     use `React.useActionState` -- that API doesn't exist in the installed React 18.3.1 (confirmed
     directly, `'useActionState' in require('react')` is `false`); a real fix means a React 19
     upgrade, out of scope for an accessibility pass.
   - Verification caveat, all three: build (`npm run build`) and the full test suite (206/206) pass
     for all of Phase 5, and the Direction rebuild's exact PostgREST query semantics were
     cross-checked against live data plus the installed `@supabase/postgrest-js` 2.115.0 `.d.ts`
     (confirming `referencedTable`, not the deprecated `foreignTable`). The one thing that could not
     be verified directly is the actual rendered, authenticated page in a browser -- this project
     deliberately keeps no login credentials available for that. Still owed a real look once someone
     can log in.
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

## 9. Correction Cycle 1 (2026-09-11) — durable pipeline + data foundations

Trigger: the QA site's authenticated review found the latest run rendering `COMPLETED` with 14 of
501 stocks actually evaluated (487 `Unavailable`) — a real dishonesty bug, not a display issue (see
below). A much larger 7-workstream correction request came with it (Direction/Analysis page
rebuilds, full BUY/SELL playbook logic, UI overhaul, security pass); by explicit agreement with the
project owner, this cycle's scope is Workstream 1 (durable pipeline) + Workstream 2 (data
foundations) only — a complete, independently-tested, independently-pushed correction. Workstreams
3-7 are unstarted, tracked for a future cycle.

**Root cause (confirmed by reading the code, not assumed):** two bugs stacked. (1)
`recordSkippedForTimeBudgetBulk` (the old `index.ts`) converted every un-attempted instrument
straight into a fake terminal `NO_DATA`/`unavailable` row once the old 125s per-invocation time
budget ran out. (2) `reconcile.js`'s `reconcileCoverage()` only ever checks that whatever results
*were* collected sum to a internally consistent tier count — it has no notion of the expected
universe size, so a fabricated 501-length array (14 real + 487 fake-unavailable) trivially
"reconciles." Fixing this needed a real "did every expected instrument get a genuine attempt" gate
that neither existing mechanism provided.

**Also confirmed before designing the fix:** this Supabase project (`yqxpucjtzrmwjniruebt`) is on
the **free plan** — Edge Functions hard-kill at ~150s wall clock — and Fyers' rate limit (paced to
180 req/min) means fetching 501 instruments' daily bars takes a mathematical minimum of ~2.8
minutes. One invocation can never cover the full universe no matter how optimized; multi-invocation
execution is structurally required, not an optimization choice.

- DONE: **`supabase/migrations/0008_durable_pipeline.sql`** (applied to the live project) —
  `claim_next_pipeline_batch(p_run_id)` (atomic `FOR UPDATE SKIP LOCKED` claim, `returns setof` per
  this codebase's established RPC convention — verified live via a fixture test using a throwaway
  test `run_id`, not a real screening run: confirmed the exact claim order
  universe→incremental→reconcile→backfill, confirmed `reconcile` is ineligible while
  `incremental` batches remain pending, confirmed zero rows returned rather than null/error when
  nothing is claimable); `reset_stale_pipeline_batches(p_run_id, stale_after_seconds, max_attempts)`
  (reclaims a batch abandoned by a dead invocation, or marks it permanently `failed` once its
  attempt budget is exhausted — also fixture-verified for both branches); two supporting indexes;
  `instrument_run_results.component_scores jsonb` (ranking's component breakdown now has to survive
  across invocations/isolates, not just live in one request's memory); a `pg_cron` job
  (`eod-screening-recovery-sweep`, every minute) that resumes a stuck/interrupted run via
  `net.http_post` — confirmed via `select * from cron.job` that no cron job existed on this project
  before this migration, and confirmed via the same query mechanism that the sweep is a no-op
  (matches zero rows) whenever nothing is actually stuck. This is explicitly **not** the standing
  daily auto-trigger cron `README.md` describes — that stays unscheduled, a separate future decision
  requiring its own authorization, since it would make the pipeline initiate new runs on its own
  schedule rather than only ever reacting to a run a human already started.
- DONE: **`supabase/functions/run-screening/index.ts`** rewritten around the batch-claim loop above
  instead of one long sequential per-instrument pass: a resume-aware `Deno.serve` handler
  (`resume_run_id` in the body skips run creation and jumps straight to claiming), self-chain
  hand-off when an invocation's own wall-clock budget is nearly spent (releases the lease *before*
  firing the continuation request — verified by reasoning through `run-lease.js`'s CAS: the next
  invocation's own `acquireRunLease` call would otherwise see the lease as still "active" and fail
  to acquire it), a whole-run `MAX_TOTAL_RUN_DURATION_MS` (40 min) give-up path that force-fails
  remaining batches and records *honest* terminal rows citing the real reason (never the old "ran
  out of time" wording used to mean "never even tried"), idempotent per-instrument retry (skip
  already-done instruments before spending any Fyers budget; `instrument_run_results` writes are
  upserts, not inserts; an instrument's own prior `data_quality_results`/`rule_traces` rows are
  cleared before rewriting), a seeded day-to-day shuffle of the processing order (fixes "always
  processes alphabetically-early symbols first"), and closes a previously-flagged gap where
  `index_memberships` rows for a dropped constituent were never retired.
- DONE: **`supabase/functions/run-screening/pipeline/`** (new directory) — `shuffle.js`
  (`seededShuffle`, FNV-1a + mulberry32, pure/deterministic), `chunks.js` (`buildChunks`,
  `CHUNK_SIZE=60` justified against the 180/min shared rate limit, `BACKFILL_CHUNK_SIZE=12`),
  `run-status.js` (`decideRunStatus` — the actual fix for the core dishonesty bug: a run is
  `completed` only when every `universe`/`incremental` batch is resolved AND every expected
  instrument has a real result row; `backfill` never blocks completion by design), `group-issues.js`
  (Data Health de-duplication). All four fully unit-tested (`*.test.js` alongside each), including
  the specific edge cases that would have silently reintroduced the original bug (a "slow but fully
  covered" run must still be `completed`, not punished for taking a long time; a batch that
  permanently failed must force `partial` even if every instrument technically has a row, since
  those rows are the honest "gave up" kind, not genuine attempts).
- DONE: **Incremental OHLCV fetch** — `providers/fyers.js`'s `fetchOHLCV` split into a
  `fetchOHLCVRange(instrumentId, symbol, fromDate, toDate, supabase)` primitive plus a pure,
  unit-tested `nextIncrementalRange(latestStoredSessionDate, runDate, fallbackLookbackDays)`: each
  instrument now fetches only the days missing since its last stored bar (typically 1-5) instead of
  re-fetching the full 365-day window every run, then `index.ts` re-reads the complete window back
  from storage for every downstream feature (EMA-200/MACD warm-up etc. still need the full window —
  only the *fetch* is incremental, never the analysis input).
- DONE: **Bounded historical backfill** — a new `backfill` `pipeline_batches` stage (self-limiting:
  created only for instruments with zero stored daily bars, so an instrument never generates a new
  one once it has any history), fetching up to 5 years via up to 5 sequential ≤366-day legs.
  PROJECT_DEFAULT: no source document specifies an exact bar/year count for "Primary-degree Elliott"
  or monthly structure validation; sanity-checked against MACD's own documented ~35-monthly-bar
  (~3-year) warm-up (`docs/swing-strategy-extraction.md`) with real margin to spare.
- DONE: **ADX/DMI** — `features/indicators.js`'s new `adx(highs, lows, closes, period=14)`,
  Wilder-smoothed +DI/−DI/ADX, unavailable until `2*period` bars exist (matching
  `papa-price-action-SKILL.md` §9's "discard the first ~28 bars"). Unit-tested against synthetic
  trending/choppy fixtures (directional dominance, relative strength, valid 0-100 range) since no
  canonical reference calculation was available to check against exactly. `config/parameters.yaml`
  correction: `adx_dmi_period` moved from `project_defaults_requiring_backtest` to `documented: 14`
  — two independent source documents state "14, 14... Wilder confirmed," so leaving it under the
  guessed-default section was itself a small mislabeling bug. The indicator is implemented; no rule
  consumes it yet, and the ADX<14-vs-ADX<20 threshold conflict this doc already flagged stays
  unresolved (implementing the math doesn't resolve which threshold a future gate should use).
- NOT DONE / disclosed, not silently skipped: **corporate-action ingestion**. No source for real
  `corporate_actions` rows was identified this cycle (the adjustment math, `computeAdjustedBars`,
  was already correct from an earlier session and is unchanged). A genuinely new finding from this
  cycle's research: whether Fyers' `/data/history` REST endpoint itself already returns
  split/bonus-adjusted prices could **not** be confirmed from public documentation — only that the
  separate charting UI is confirmed adjusted, with a user-facing toggle. This must be empirically
  verified (compare a known past split's pre/post prices) before corporate-action ingestion is ever
  built, to avoid double-adjusting.
- Verification: `npm test` from `stock-platform/` (256 tests: 244 Edge Function + 12 app-side, all
  passing), `npm run build` from `stock-platform/app` (passes), the live RPC fixture test described
  above (applied the migration, exercised both new functions against a throwaway `run_id` with real
  Postgres locking semantics, deleted the fixture rows). Deliberately **not** verified: an actual
  live screening run — the project owner's standing constraint against triggering one without
  separate explicit authorization was maintained throughout. This means `index.ts`'s Deno-only
  runtime paths (everything gated behind `Deno.serve`) are verified by code review, unit tests of
  every extracted pure function, and the live database-level fixture test, but not by an end-to-end
  execution — flagged honestly as the one thing that still needs a real run to fully confirm.
- Bugs caught and fixed during this cycle's own code review, before they ever shipped (worth
  recording since they're exactly the kind of subtle correctness issues this whole correction is
  about avoiding): (1) releasing the run lease *after* firing the self-chain request would have
  raced the handed-off invocation's own lease acquisition; (2) the first draft of
  `claim_next_pipeline_batch` returned a single composite row rather than a set, inconsistent with
  how every other RPC in this codebase is called (`data[0]`, never `.single()`); (3) the first draft
  ranked `backfill` above `reconcile` in claim priority, which would have let a run with many
  pending backfill chunks block its own completion indefinitely — exactly the kind of contradiction
  with `decideRunStatus`'s "backfill never blocks completion" rule that this whole exercise exists
  to prevent; (4) the first draft's idempotency guard on the `universe` batch could skip re-seeding
  entirely after a partial crash, permanently stranding a run at `queued`.

## 10. ADX threshold conflict resolved + hourly combination-matrix WAIT gate (2026-09-11)

Trigger: `features/indicators.js`'s `adx()` was implemented and tested in Correction Cycle 1 (§9)
but left unconsumed, blocked on `docs/swing-strategy-extraction.md` §13 conflict #4 (ADX < 14,
swing-specific, vs. the general PAPA/cross-check ADX < 20 no-trend reading). This closes that gap:
the conflict is resolved as a disclosed `PROJECT_DEFAULT`, and a real gate now consumes `adx()`.

- **DONE — conflict #4 resolved.** `swing-strategy-extraction.md` §13 conflict #4 now carries a
  RESOLVED note: the swing (Weekly→Daily→1H) playbooks' own hourly combination-matrix WAIT rule
  ("Hourly ADX below 14, or flat under 25 → WAIT", `BUY...` §11 / `SELL...` §13) is adopted for that
  check only, per `AGENTS.md`'s Evidence Priority (a dedicated setup checklist for this exact
  strategy/timeframe outranks a general concept document) and because the swing playbooks
  self-disclose a reasoned deviation from the general 20-threshold, not an oversight. Scope is
  explicitly hourly-only and swing-only — the general PAPA/ADX-20 no-trend reading is untouched
  everywhere else, since nothing else in this codebase consumes an ADX no-trend threshold today.
  `config/parameters.yaml` bumped to `parameter_version 1.4.0`: new `swing_hourly_adx_wait_below: 14`
  and `swing_hourly_adx_flat_ceiling: 25`, both fully commented with the resolution rationale.
  **Not yet seeded** to the remote project's `parameter_versions` table (`supabase/seed/seed-strategies.mjs`
  would need to run) — same standing constraint as `buy-swing.yaml`/`sell-swing.yaml` themselves,
  which are also still unseeded; until seeded, `parameterValues.swing_hourly_adx_wait_below` reads
  `undefined` in production and the new gate below degrades to `null` (never a guessed verdict).
- **DONE — `features/indicators.js`'s new `adxSlope(highs, lows, closes, period, lookback=3)`** —
  "rising"/"falling"/"flat" classification of the ADX line's own trajectory, mirroring the existing
  `macdSlope`'s monotonic-tail convention exactly (needed because the WAIT rule's second branch,
  "flat under 25," is about ADX's slope, not just its level). Unit-tested against four synthetic
  fixtures: too few bars (null), a pure single-direction trend (a clean derivation: with no opposing
  directional movement, DX pins at exactly 100 from the first computed bar onward, so ADX is
  constant → "flat"), a choppy period giving way to a strong trend ("rising"), and a strong trend
  decaying into chop ("falling").
- **DONE — new `features/hourly-conditions.js`, `evaluateHourlyAdxCondition()`.** Deliberately its
  own module, not folded into `features/hourly-routes.js` (whose header comment scopes it to
  Elliott-setup detectors only, not this) or into the `WBP-`/`WSP-` YAML rule IDs (reserved for the
  literal 8-gate table per §13 conflict #10's own warning against merging different taxonomies) —
  the source documents themselves place this in a separate "combination matrix" section, not the
  8 mandatory gates table. Returns the observed ADX/±DI/slope evidence plus a `wait` boolean and
  human-readable `reason`, or `null` when ADX isn't seeded yet (never a guessed verdict). Unit-tested:
  null before enough bars, `wait: true` on a choppy/low-ADX fixture, `wait: false` on a
  clearly-trending one, and that the raw evidence is always returned regardless of the verdict.
- **DONE — wired into `index.ts`.** `ingestHourlyBarsAndDetectRoutes` now also computes this
  condition once per instrument (same hourly bars already fetched for route detection; ADX measures
  trend strength, not direction, so one computation serves both hypotheses) and returns it alongside
  the per-hypothesis route arrays. `evaluateSwingHypothesis` (`features/swing-analysis.js`) takes it
  as a new optional third argument, backward-compatible (omitting it reproduces the exact prior
  behavior — verified by the pre-existing test suite passing unchanged): it never changes
  `final_action` (`WBP-M5..M8`/`WSP-S5..S8` already keep that `WAIT` regardless, for the same
  disclosed reasons as before) but always discloses the evidence, either a WAIT reason or an explicit
  "does not block entry" note, in `pending_conditions`, plus the raw evidence in a new
  `combinationMatrix` field. `persistSwingAnalysisResults` writes that to a new
  `swing_analysis_results.combination_matrix jsonb` column, added to migration `0006` (still
  unapplied — safe to extend, same as `route_evidence`/`triggered_bullish_pattern_id` before it).
- Tests: 4 new cases in `indicators.test.js` (`adxSlope`), 4 in new `hourly-conditions.test.js`, 3 in
  `swing-analysis.test.js` (the new parameter's default-omitted, WAIT, and non-WAIT disclosure
  cases). Full suite: 258/258 passing (`npm test` from `stock-platform/`).
- Not in scope for this pass, disclosed rather than silently left implicit: the other combination-matrix
  entries the swing playbooks' §11/§13 sections describe alongside the ADX condition (route quality,
  the 100-point scorecard's own bands) are unrelated to the ADX conflict this pass resolved and remain
  exactly as REMAINING as `architecture-plan.md` §6 Phase 4 already states.

## 11. Correction Cycle 2 (2026-09-11) — BUY/SELL decision logic (M6-M8, remaining routes, confirmation groups, vetoes)

Trigger: the Analysis page's own banner disclosed that `final_action` was permanently `WAIT` for
every stock, every run — correctly disclosed, not a bug, but the deferred Workstream 5 from the
original 7-workstream correction request. This cycle implements it, scoped to everything buildable
on already-resolved or newly-disclosed, reversible `PROJECT_DEFAULT` picks — the same discipline
this project already used for the ADX threshold (§10) — while explicitly declining pieces that would
require inventing a genuinely undocumented method, not just picking a point in a stated range.

- DONE — **SELL-1 "Wave 5 Exhaustion"** (`features/hourly-routes.js#detectWave5Exhaustion`), the
  third of the 10 hourly routes, a standalone top-exhaustion route with no bullish mirror: a
  completed bullish 5-wave impulse (GUE hard gates satisfied by construction) whose 5th wave is
  weaker or truncated, confirmed by hourly RSI divergence (wave 3 vs. wave 5 — only the hourly
  reading is automated; the source's own required daily cross-check is disclosed as NOT
  implemented) and a wave3>wave5 hour-slot volume falloff, entered on an hourly close below wave
  4's low. Verified against a real, non-hand-forced fixture (the actual computed RSI values diverge,
  not asserted by construction).
- DONE — **M6, PAPA price-action trigger** (`features/papa-formations.js`, new): the
  DOCUMENTED-mechanism subset of the 10 BUY/10 SELL PAPA formations — Bull/Bear Counter Attack,
  Genuine/Fake Breakout/Breakdown, Gap Up/Down, Mother Candle (reversal + continuation) — each
  following `patterns.js`'s own OBSERVED-vs-TRIGGERED discipline. "A level" reuses confirmed zigzag
  pivots (hourly or daily) within `patterns.js`'s existing `DOUBLE_EXTREME_TOLERANCE`. NOT
  implemented: Sandwich breakout/breakdown, Rounding bottom/top (deferred for scope, not a
  specification gap), Accumulation/Distribution, Tweezers (genuinely UNRESOLVED — no number anywhere
  in any source for their qualitative terms).
- DONE — **M7, SMM Bull/Bear Hat** (`features/smm-hat.js`, new): Step 1 (the Tide, daily) reuses the
  same MACD histogram phase and Dow state WBP-M4/WSP-S4 already compute. Step 2 (the Wave, 1-hour)
  resolves swing-strategy-extraction.md §13 conflict #11 by reusing, unchanged, the exact disclosed
  crossover choice already made for the positional strategy's `BSP-M7B`/`SSP-S7B` (Stochastic %K/%D
  cross <20/>80, OR RSI cross through 40/60), re-applied to the 1-hour chart. Hat = BUY/SELL only
  when both steps agree; any disagreement is "no hat," per the source's own "no hat and no trade."
- DONE — **M8, reward:risk** (`features/reward-risk.js`, new): wires the strict `> 3.0` threshold
  (new `config/parameters.yaml` key `swing_minimum_reward_risk_strict: 3.0`, finally added — §7
  decision 1 had approved this but it was never actually written to the parameters file until now)
  against whichever M5 route's own stop/target evidence exists. Picks the nearest (most
  conservative) target when a route exposes several. Returns null — never a guessed number — when
  the selected route has no computable target (true today for BUY-4/SELL-4's pattern-based entry).
- DONE — **5 confirmation groups** (`features/confirmation-groups.js`, new): the disclosed
  `PROJECT_DEFAULT` synthesis already decided in §7 decision 3, finally implemented — Structure &
  level, EMA & Fibonacci, Momentum, Price action & pattern, Participation & regime — each populated
  from evidence the modules above already compute, every group citing its real source locator.
  Passes at ≥4 of 5.
- DONE — **Vetoes** (`features/swing-vetoes.js`, new): the subset checkable from already-computed
  evidence — an hourly close breaching wave 1's origin, wave 4 entering wave 1's territory (where
  the route's own shape carries both fields), a daily close below/above the last HL/LH, the weekly
  MACD histogram turning against the trade, reward:risk falling below the strict threshold, a
  gap-only break, and price closing back inside the pattern within 1-2 bars. NOT implemented,
  disclosed per §13 conflict #10: the two cross-check-only vetoes with no primary-playbook match
  ("EMA tangled + ADX ranging"; "monthly/weekly Elliott count invalid/ambiguous") — an open
  strategy-owner decision neither source document resolves.
- DONE — **`features/swing-analysis.js#evaluateSwingHypothesis` now computes a real `finalAction`**:
  BUY/SELL only when ALL EIGHT gates pass (M1-M4 from the pooled rule traces, M5-M8 from the new
  evidence bundle above) AND ≥4-of-5 confirmation groups AND zero vetoes — otherwise WAIT, with the
  specific blocking gate/group/veto named in `pending_conditions`, never a bare unexplained WAIT.
  `index.ts`'s `ingestHourlyBarsAndDetectRoutes`/`persistSwingAnalysisResults` extended to gather and
  pass through the full evidence bundle; no new migration needed (`swing_analysis_results`'s
  `confirmation_groups`/`vetoes`/`route_evidence`/etc. columns already existed, unapplied, from
  migration `0006`). `strategies/buy-swing.yaml`/`sell-swing.yaml`'s WBP-M6..M8/WSP-S6..S8 notes
  updated to disclose the pooling-vs-real-evidence split: the pooled `rule_traces` row for each gate
  ID still reads `MANUAL_REVIEW` (M5-M8 never fit the shared YAML/rule-engine path M1-M4 use, same
  reason as before), but real evidence now genuinely gates `finalAction` from the columns above.
  Analysis page banner and per-stock "why not BUY/SELL" heading updated to match (no longer claims
  `finalAction` is always WAIT; the heading no longer renders nonsensically when a verdict IS
  BUY/SELL).
- **Explicitly OUT of scope, disclosed, not silently dropped** — three different kinds of gap, not
  one:
  - **BUY-2** (Wave 4 Completion): the documented trigger ("an hourly close above the wave-4 high")
    is genuinely ambiguous in what the extraction doc transcribes; the fuller source table needed to
    resolve it isn't available. Unchanged from Correction Cycle 1's own original decision.
  - **BUY-3/SELL-2** (Ending Diagonal Reversal/Breakdown): unlike every other gap resolved this cycle
    (a disclosed point picked from a *stated range*), this needs "two boundary lines through actual
    pivots, extended forward, confirmed converging" — no source document specifies which pivots
    anchor each boundary, over what span, or by what fitting method. A regression or any other
    fitting choice would be inventing a *procedure* the source never describes, a materially
    different and larger kind of guess than picking a disclosed default within a stated range. Stays
    undone pending a real worked example from the strategy owner.
  - **BUY-5/SELL-5** (Continuation Add): zero numeric checks anywhere in the source — no range exists
    to pick a default from at all.
  - Sandwich/Rounding-bottom PAPA formations: documented mechanism, deferred for scope this cycle
    (not a specification gap — can be picked up in a future pass without new decisions).
- Verification: `npm test` from `stock-platform/` (310/310 passing, up from 258 — every new module
  fully unit-tested, including fixtures that prove real computed divergence/crossover behavior rather
  than asserting by construction), `npm run build` from `stock-platform/app` (passes). Deliberately
  NOT verified by triggering a live screening run — same standing constraint as every prior cycle;
  the next user-triggered run will be the first real end-to-end confirmation that a genuine BUY/SELL
  can now appear on the Analysis page for a stock that legitimately earns one.

## 12. First live run of Correction Cycle 2, two production bugs found and fixed (2026-09-11)

The user manually triggered the first live run after Cycle 2's Edge Function deploy. It came back
`partial` (run `383a8781`), and the Direction page (a separate, earlier-built feature, unrelated to
the swing/BUY-SELL work) started showing "Unavailable" for nearly every stock. Both were real,
diagnosed bugs, fixed and pushed the same session:

- **`swing_analysis_results` was missing `combination_matrix`.** An earlier session's ADX/DMI work
  (§10) added this column to migration 0006's *file* but never deployed it live — the file's own
  comment said so ("migration still unapplied"). Every swing-analysis upsert this cycle's new
  BUY/SELL logic depends on was silently failing with a real (non-"table missing") Postgrest error
  on every single instrument, logged only as a `warning`, never surfaced loudly. Fixed live via
  `execute_sql`/`apply_migration` with the user's explicit authorization, recorded locally as
  `supabase/migrations/0009_add_combination_matrix.sql` so the migration history matches what's
  deployed.
- **The Direction page's `instrument_direction` query filtered by the published run's `run_id`.**
  That table is a mutable "latest write wins" store (`onConflict: "instrument_id,timeframe"`, no
  run_id in the unique key) — index.ts's `upsertDirectionAnalysis` stamps whichever run last touched
  an instrument onto its row, including a run that ends up `partial` and never gets published.
  Confirmed live: the manually-triggered run overwrote ~497 of 501 instruments' `run_id` this way,
  and the page's strict `.eq("run_id", run.id)` filter made every one of them vanish even though
  their dow_state/chart data was completely current. Fixed by dropping that filter — `lib/data/
  direction.ts` now reads `instrument_direction` as genuine latest-state (instrument_id only), which
  is both simpler and matches what the table's own write path actually guarantees. The properly
  run-scoped equivalent (`instrument_direction_runs`, unique on `run_id, instrument_id, timeframe`,
  never overwritten cross-run) exists and is unaffected, but isn't used by the page today.
- Verified live directly against the database (not just unit tests) before pushing: confirmed the
  missing column now exists, and confirmed a specific previously-invisible instrument
  (`NSE_LAURUSLABS`) has real, current daily/weekly/monthly `dow_state` data that the old filtered
  query was excluding.

## 13. Correction Cycle 3 — remaining PAPA formations from Cycle 2's own deferred scope (2026-09-11)

The two DOCUMENTED-mechanism PAPA formations Cycle 2 deferred for scope, not principle:

- **Sandwich breakout/breakdown** (`features/papa-formations.js#detectSandwich`) — alternating red/
  green candles form a range (no separate "compactness" number needed: the range IS the alternating
  run's own high/low, so requiring the breakout to clear that same boundary already enforces
  compactness), then a candle closes beyond both the immediately preceding candle's close and that
  range's edge. No follow-up candle is documented for this row (unlike Counter Attack/Gap) — TRIGGERS
  on the breakout candle itself.
- **Rounding bottom/top** (`features/papa-formations.js#detectRounding`) — reuses
  `rounding_pattern_body_size_multiplier` (disclosed in Cycle 2, unused until now) as one ratio in
  three places: the initiating same-colour candles' bodies must be at least that multiple of the
  base's own average body, the base candles must be no more than that same multiple below the
  initiating candles' own average, and the breakout candle must clear that multiple again against the
  base — one disclosed number, not three invented ones.
- Both wired into `detectTriggeredPapaFormations`/`index.ts`'s M6 evidence gathering; Analysis page
  banner updated to no longer list them as unimplemented.
- **Still explicitly NOT implemented, disclosed rather than forced**: the 2 cross-check-only vetoes
  from conflict #10 (swing-strategy-extraction.md §6/§13). Re-examined this cycle, not just carried
  over unchanged: "EMA tangled while ADX shows a range" would need inventing a numeric "tangled"
  threshold no source document states (the ADX half alone reuses existing evidence, but the EMA half
  doesn't); "monthly/weekly Elliott count invalid/ambiguous" would need monthly-timeframe Elliott
  position data `features/context.js` doesn't compute at all today (only weekly and daily get
  `withElliott: true` in `applyTimeframe` — monthly never has). Both stay open, for the same
  never-invent reason as before, now with the specific blocker named rather than left generic.
- Verification: `npm test` (318/318 passing, up from 310 — 6 new detector tests plus 2 aggregator
  tests), `npm run build` (passes). Detector logic verified against hand-built fixtures interactively
  before finalizing the test file (same discipline as Cycle 2's RSI-divergence fixture work).

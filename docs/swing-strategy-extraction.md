# Swing Strategy Extraction — Weekly → Daily → 1H BUY / SELL Playbooks

Prepared for the lead architect who will build versioned strategy YAML for the swing
(intraday-entry) BUY and SELL playbooks. This document is research and extraction only —
no YAML, code, or repository state was changed to produce it.

Status vocabulary follows `stock-platform/references/rule-schema.md`: `DOCUMENTED`,
`PROJECT_DEFAULT`, `INFERRED`, `CONFLICT`, `UNRESOLVED`. Where a source gives an
approximate value ("~5%", "roughly", "about") it is marked `DOCUMENTED (approximate)` —
the concept is sourced, but the exact number the pipeline should use is still a
`PROJECT_DEFAULT` decision, listed again in §13.

---

## 1. Source register

All paths below are under `C:\Projects\stockmarket\concepts` unless marked otherwise.

| File | What it authoritatively covers |
|---|---|
| `smm-chart-analysis-SKILL.md` | SMM Concepts Part 1 — Dow-theory trend, HH/HL/LH/LL structure, support/resistance rules, the 5 bullish + 5 bearish candlestick patterns, volume reads, the six-step verdict method |
| `smm-chart-patterns-SKILL.md` | SMM Concepts Part 3 — chart (formation) patterns: Head & Shoulder, Double Top, Inverted H&S, Double Bottom, Cup & Handle, Flag & Pole (bull/bear); the universal "D" measured-move target rule |
| `smm-decision-sheet-SKILL.md` | SMM Decision Check List — the double-screen (Tide/Wave) Bull/Bear Hat, the 13-check decision sheet, and the reward/risk gate ("must be above 3") |
| `smm-ema-fibonacci-SKILL.md` | SMM Concepts Part 2 — EMA 5/13/26/50 computation and reading, crossover detection and grading, Fibonacci retracement anchoring and levels |
| `smm-indicators-SKILL.md` | SMM Concepts Part 4 — MACD(12,26,9), RSI(14, Wilder), Stochastic(14,3,3), overbought/oversold reads, divergence detection method |
| `gue-elliott-wave-SKILL.md` | GUE Concepts Parts 1–3 — the 3 hard Elliott rules, motive/corrective wave taxonomy, guidelines (equality, alternation, depth of correction, channeling, throw-over, volume), Fibonacci wave relations, counting method |
| `gue-ending-diagonal-SKILL.md` | Ending Diagonal Setup checklist — the wedge/EDT trade: 3 mandatory + 5 supporting conditions for BUY and SELL, stop/target rules, vocabulary (BBNC, Ungli, BBC) flagged as inferred |
| `papa-price-action-SKILL.md` | PAPA Concepts Parts 1–3 — candlestick catalogue read only at levels, counter attacks, sandwich, accumulation/distribution, tweezers, combining candles, Heikin Ashi, Bollinger 2/3 SD, DMI/ADX(14,14, Wilder) |
| `papa-decision-sheet-SKILL.md` | PAPA Decision Sheet (Sep-22) — 10 named BUY setups + 10 named SELL setups, each as observation/trigger/supportive/stop/target; vocabulary (Weapon, BKP, BKT, BBC failed, Ungali) flagged as inferred |
| `playbooks\BUY_Signal_Playbook_Weekly_Daily_1H.md` | **PRIMARY** — the swing BUY playbook: Weekly(Ocean)→Daily(Tide)→1‑Hour(Wave) gated procedure, gates M1–M8, setups BUY‑1…BUY‑5, 100‑point scorecard, combination matrix, kill conditions, output template |
| `playbooks\SELL_Signal_Playbook_Weekly_Daily_1H.md` | **PRIMARY** — the swing SELL playbook: Tier‑1 exit‑long ladder + Tier‑2 short‑entry gates S1–S8, setups SELL‑1…SELL‑5, 100‑point scorecard, combination matrix, kill conditions |
| `buy-signal-analysis\SKILL.md` | Cross‑check only. Routing skill for the **positional** (Monthly→Weekly→Daily) buy checklist; operating sequence and verdict rule |
| `buy-signal-analysis\references\buy-conditions.md` | Cross‑check only. Positional BUY reference: universal gates, Elliott combination matrix, Routes A–E, execution matrix, "5 independent confirmation groups (≥4 of 5)" rule, vetoes |
| `playbooks\SELL_Signal_Playbook_Weekly_Daily_1H.md` | (see above) |
| `sell-signal-analysis\SKILL.md` | Cross‑check only. Routing skill for the **positional** sell/short checklist; distinguishes new-short vs exit-long |
| `sell-signal-analysis\references\sell-conditions.md` | Cross‑check only. Positional SELL reference, mirror of buy-conditions.md |

Also read, under `C:\Projects\stockmarketclaude\stock-platform`, to align vocabulary and
discover pre-existing extraction work:

| File | Relevance |
|---|---|
| `AGENTS.md`, `CLAUDE.md` | Master project rules — provenance discipline, terminal states, hard-gate semantics, reward/risk floor (`>= 3.0`), evidence-priority order |
| `references/rule-schema.md` | Required fields and status vocabulary for every executable rule |
| `references/source-register.md` | Canonical source PDFs and a list of **already-known** unresolved terms/conflicts (BBNC, BKP/BKT aliasing, 8%/10% monthly-loss conflict, etc.) |
| `strategies/gue.yaml`, `strategies/shared-gates.yaml`, `strategies/smm.yaml`, `strategies/papa.yaml` | Existing YAML shape/vocabulary to stay consistent with |
| `strategies/buy-signal-playbook.yaml`, `strategies/sell-signal-playbook.yaml` | **Already encode the POSITIONAL playbook** (`playbooks/BUY_Signal_Playbook.md` / `SELL_Signal_Playbook.md`, Monthly→Weekly→Daily), using gate IDs `BSP-M1…M8` / `SSP-S1…S8`. This is a different document from this task's target (the `_Weekly_Daily_1H` swing variant) but reuses the same gate letters — see conflict #2 in §13. |

---

## 2. BUY routes (BUY-1 through BUY-5)

Source: `BUY_Signal_Playbook_Weekly_Daily_1H.md`, §4 "Stage 3 — THE WAVE (1-hour). Gate M5
— the Elliott setup". All five routes require gates M1–M4 (weekly + daily direction and
Elliott position) to have already passed — they are 1‑hour **entry** setups, not
standalone gates. Setup selection table: §4.1, "M5 passes only if the hourly chart is in
one of these five positions".

### BUY-1 · Wave 3 Ignition
*Locator: §4.2 "BUY-1 · Wave 3 Ignition: the full validation", 9-row table + targets/stops.*

- **Required prior structure:** a significant hourly low starting wave 1 up (impulsive personality, ideally 5 sub-waves at 15-min degree); wave 2 must have **completed** and price turned up from it.
- **Trigger:** "an hourly close above the high of wave 1" (check 6) — explicitly **not** the same event as price merely approaching that level, and explicitly not valid if that close was produced only by the session's opening gap (§1.3 cross-reference).
- **Other required checks:** Rule‑1 arithmetic (wave 2 retracement < 100%, printed), volume on the trigger candle above its **hour-slot** average AND wave‑3 volume > wave‑1 volume (check 7), Rule‑3 forward-check that the minimum viable wave‑3 target (end of wave 2 + length of wave 1) sits at or above the nearest major **daily** resistance (check 8).
- **Quality (non-required) checks:** wave‑2 depth 38.2–61.8% (check 4), wave‑2 character/alternation note (check 5), hourly MACD positive crossover near zero (check 9).
- **Targets:** 1.62× / 2.62× / 4.25× wave 1 from the end of wave 2, cross-checked against nearest daily resistance (nearer of the two wins).
- **Stops:** tight = below end of wave 2; structural = below origin of wave 1 (rule‑1 invalidation).
- **DOCUMENTED vs needs PROJECT_DEFAULT:** the trigger, the three Elliott‑rule tests, and the volume requirement are DOCUMENTED with exact mechanics. What is **not** pinned: the hourly zig-zag threshold used to find wave 1/2 pivots (§1.1, "1–1.5% hourly" — a range) and the hour-slot volume lookback (§1.2, "10–20 sessions" — a range). Both are PROJECT_DEFAULT decisions (see §13).

### BUY-2 · Wave 4 Completion
*Locator: §4.3 "BUY-2 · Wave 4 Completion", 8-row table.*

- **Required prior structure:** wave 3 complete and identified; wave 4 correction must **not** have entered wave 1's price territory (Rule‑2 arithmetic, check 2) unless it is a diagonal.
- **Trigger:** "an hourly close above the wave-4 high, or above the triangle's B-D line, on above-hour-slot-average volume" (check 7) — marked **required**.
- **Other required checks:** wave‑4 retracement 23.6% or 38.2% of wave 3 (75%-probability band; 50–62% is the 25% case and a "warning", check 3); depth-of-correction level quoted (check 4, required); volume contracted through wave 4 and expands on trigger (check 8).
- **Quality checks:** alternation vs wave 2 (check 5); if wave 4 is a triangle, it must be complete through wave E with **at least five real pivots** — an explicit numeric floor, stated so an hourly "triangle" is not mistaken for a midday lull (check 6).
- **Targets:** conditional on wave 3 vs 1.62× wave 1 (two branches, see full text); primary target is the channeling target (parallel line through end of wave 3, from waves 2–4).
- **Stop:** below the wave-4 low. **Invalidation:** hourly close inside wave 1's territory.
- **Ceiling note:** wave 5 is documented to complete on weaker strength than wave 3 — expect divergence and a channel miss; "at Minute degree this trade is often worth one target and no more."

### BUY-3 · Ending Diagonal Reversal
*Locator: §4.5 "BUY-3 · Ending Diagonal Reversal (falling wedge breakout)"; mirrors `gue-ending-diagonal-SKILL.md` §2.*

- **Required prior structure:** a fitted falling wedge — two boundary lines through actual pivots, extended forward, confirmed **converging** (a wedge whose lines diverge is not this setup) — completing a 5th wave down or a C wave down. Sits **on top of** M1–M4, not instead of them.
- **Mandatory, joined by AND (ED‑1…ED‑3):**
  1. ED‑1 — daily MACD histogram **UPTICK, or FLAT AFTER A DOWN** phase.
  2. ED‑2 — daily candle **BBNC — DN** (at/near the lower Bollinger band). *BBNC is flagged INFERRED, not expanded on the source sheet — `gue-ending-diagonal-SKILL.md` §1.*
  3. ED‑3 — the 1‑hour ending diagonal **closes OUT above its upper boundary**.
- **Supporting (ED‑4…ED‑8, grade the setup, never substitute for ED‑1…3):** hourly RSI bullish divergence; Ungli setup (INFERRED term); double-screen confirmation; hourly MACD PCO; histogram converging + trendline breakout.
- **Volume:** above-hour-slot-average on the breakout candle — explicitly a **MUST**, not optional.
- **Stop:** below the breakout candle, or below the Bollinger band candle (BBC).
- **Targets:** (1) the starting point of the wedge (a diagonal fully retraces); (2) the depth of correction — the 4th sub-wave of the earlier wave.
- **Extra hourly-specific caution (not in the generic `gue-ending-diagonal-SKILL.md`):** "an hourly falling wedge that has run for only six or eight candles is not an ending diagonal... Require enough structure for five distinguishable sub-waves — in practice at least **fifteen to twenty hourly candles**." This numeric floor is a range, not a fixed number → PROJECT_DEFAULT.

### BUY-4 · Wave 2 Pullback
*Locator: §4.4 "BUY-4 · Wave 2 Pullback", 5-row table.*

- **Required prior structure:** a completed five-wave down or completed a-b-c down immediately behind on the hourly; a fresh wave 1 up printed with impulsive personality.
- **Trigger:** "a bullish reversal trigger prints at that Fibonacci level" (check 4, PAPA trigger per §5) — **required**, and it must occur at a wave‑2 retracement of 38.2–61.8% of wave 1 (50%/61.8% ideal) that has **not breached the origin of wave 1** (check 3).
- **Quality:** the Fib level coinciding with hourly EMA 26/50, or better a level that also exists on the daily chart — "the confluence that makes the entry A-grade" (check 5).
- **Stop:** below the origin of wave 1. **Target:** the BUY‑1 wave‑3 objectives.
- **Design note in source:** this setup is explicitly justified as usable even under an *ambiguous* wave count — "you do not need to know whether that low was a (i) or a (c)... if it breaks, you are wrong," converting ambiguity into a defined‑risk trade rather than requiring full count resolution.

### BUY-5 · Continuation Add
*Locator: §4.6 "BUY-5 · Continuation Add" (narrative, no numbered check table).*

- **Required prior structure:** an already-confirmed **running** wave 3 (or a confirmed wave 5 with a tight stop). Explicitly **never an initiating entry**, and never taken if the original position is already at a loss.
- **Trigger (one of):** a bull-flag breakout, a mother-candle breakout in between the trend, a genuine breakout with a prior shakeout, or a sustained gap up above resistance.
- **Stop:** always at the low of the formation. Position sized smaller than the original.
- **DOCUMENTED vs PROJECT_DEFAULT:** this route has no numeric checks at all in the source — it is entirely structural/qualitative. Any executable rule for BUY‑5 requires PROJECT_DEFAULT decisions for what counts as "already running" (e.g., a minimum number of confirmed sub-waves) and for position-size scaling.

---

## 3. SELL routes (SELL-1 through SELL-5)

Source: `SELL_Signal_Playbook_Weekly_Daily_1H.md`, §6 "Stage 3 — THE WAVE (1-hour). Gate
S5". Selection table §6.1. Subsection numbering does **not** follow setup-number order in
the source (§6.2=SELL‑1, §6.3=SELL‑3, §6.4=SELL‑2, §6.5=SELL‑4, §6.6=SELL‑5) — noted so the
locators below are read correctly against the source file.

### SELL-1 · Wave 5 Exhaustion
*Locator: §6.2 "SELL-1 · Wave 5 Exhaustion", 8-row table.*

- **Required prior structure:** waves 1–4 up labelled, all three Elliott rules PASS with arithmetic (check 1).
- **Core condition:** wave 5 made a new high **on weaker strength than wave 3**, or has **truncated** (fails to exceed wave‑3 top while still containing 5 sub-waves) — check 2, required.
- **Required confirmation:** divergence (price HH, oscillator LH) on RSI and/or Stochastic and/or MACD — "an hourly divergence that the daily contradicts is close to worthless — check the daily first" (check 3); volume check — 3rd‑wave volume should exceed 5th‑wave volume on hour-slot terms, else "suspect a fifth-wave extension and wait" (check 5, required).
- **Trigger:** "an hourly close below the wave-4 low" (check 7) — **required, this is the entry**; not valid on a gap-only close (§3.1 cross-reference); volume on trigger candle above hour-slot average (check 8, required).
- **Quality:** channel-line miss (check 4), throw-over/volume-spike tell (check 6).
- **Targets, in order of reliability:** (1) depth of correction of the previous 4th wave one lesser degree; (2) zigzag channel wave-c estimate; (3) Fibonacci (c = a, 1.62×a, 2.62×a); (4) nearest major daily support if nearer.
- **Stop:** above the wave-5 high. **Invalidation:** hourly close above the wave-5 high.

### SELL-2 · Ending Diagonal Breakdown
*Locator: §6.4 "SELL-2 · Ending Diagonal Breakdown (rising wedge)"; mirrors `gue-ending-diagonal-SKILL.md` §3.*

- **Required prior structure:** a fitted **rising** wedge, boundaries through real pivots, confirmed converging, apex time given, completing a 5th wave up or C wave up. On top of S1–S4.
- **Mandatory, joined by AND (ED‑1…ED‑3):**
  1. ED‑1 — daily MACD **DOWNTICK, or FLAT AFTER AN UP** phase.
  2. ED‑2 — daily candle **BBNC — UP** (INFERRED term).
  3. ED‑3 — the 1‑hour ending diagonal **closes DOWN below its lower boundary**.
- **Supporting (ED‑4…ED‑8):** hourly RSI bearish divergence; Ungli setup (INFERRED); double-screen confirmation; hourly MACD NCO; histogram converging + trendline breakdown.
- **Volume:** above-hour-slot-average on the breakdown candle — MUST.
- **Stop:** above the breakdown candle, or above the BBC.
- **Targets:** (1) starting point of the wedge; (2) depth of correction of the earlier 4th sub-wave.
- **Same "15–20 hourly candles" structural-minimum caution as BUY‑3** — PROJECT_DEFAULT needed.

### SELL-3 · Wave 3-Down Ignition
*Locator: §6.3 "SELL-3 · Wave 3-Down Ignition (the mirror of the flagship buy)", 8-row table.*

- **Required prior structure:** wave 1 down identified from a significant hourly high, impulsive personality; wave 2 up **complete** and price turned down from it.
- **Trigger:** "an hourly close below the low of wave 1 down" (check 5) — **required, this is the entry**; not on a gap alone.
- **Other required checks:** Rule‑1 arithmetic printed (check 3); wave 2 bounce into 38.2–61.8% of wave 1, "beyond 78.6% the downtrend is probably over — treat it as a reversal, not a bounce" (check 4, required); volume above hour-slot average on trigger (check 6, required); Rule‑3 forward-check — minimum viable target (end of wave 2 − length of wave 1) must not be blocked by daily support above it (check 7, required).
- **Quality:** hourly MACD negative crossover near zero (check 8).
- **Targets:** 1.62×/2.62×/4.25× wave 1 down from end of wave 2 (1.62× realistic at this degree); nearest major daily support takes precedence if nearer.
- **Stops:** tight = above end of wave 2; structural = above origin of wave 1 down.

### SELL-4 · Bounce Failure
*Locator: §6.5 "SELL-4 · Bounce Failure", 6-row table.*

- **Required prior structure:** hourly downtrend intact — the last LH has not been closed above (check 1).
- **Core condition:** price rallied into the **38.2–61.8%** Fibonacci band of the last down-leg (check 2, required — "counter-trend rallies most often die here").
- **Trigger:** "a bearish reversal trigger prints there" per §7 PAPA setups (check 4) — **required**.
- **Quality:** confluence with hourly EMA 26/50 or daily horizontal resistance (check 3); volume contracted through the rally (check 5, "a rally on falling volume is corrective until proven otherwise").
- **Hard structural check:** zigzag hard edge — if this is wave b, it may not exceed 78% of wave a, else the count is wrong (check 6, required).
- **Stop:** above the rally high. **Target:** origin of the rally first, then wave-c objectives.
- **B-wave warning documented explicitly:** an expanded flat's new price extreme must not be mistaken for a resumed uptrend — check whether it is the b or c leg.

### SELL-5 · Continuation Add
*Locator: §6.6 "SELL-5 · Continuation Add" (narrative, no numbered check table).*

- **Required prior structure:** an already-confirmed running wave 3 down only.
- **Trigger (one of):** bear-flag breakdown, mother-candle breakdown in between the trend, genuine breakdown with a prior shakeout, sustained gap down below support.
- **Stop:** always at the high of the formation. Add smaller than the original.
- Same PROJECT_DEFAULT gaps as BUY-5 (no numeric checks given at all).

---

## 4. The 8 mandatory gates (bullish) and mirrored bearish equivalents

Locator: `BUY_Signal_Playbook_Weekly_Daily_1H.md` §8 "The eight mandatory gates, on one
page"; `SELL_Signal_Playbook_Weekly_Daily_1H.md` §10 (same title). All eight gates on each
side are **hard gates joined by AND** — "Any one FAIL → NO BUY" / "NO SHORT" (explicit,
same section). None is soft; the 100-point scorecard (§5) grades a setup only **after**
all eight pass and "never rescues" a failed gate (§0 of each playbook, "SUPPORTING
CONDITIONS... never rescue an invalid one").

| # | BUY gate | Chart | Passes when | # | SELL gate | Chart | Passes when |
|---|---|---|---|---|---|---|---|
| M1 | Weekly Dow direction | weekly | Uptrend (HH+HL) intact, or confirmed reversal (§2, M1 table) | S1 | Weekly Dow direction | weekly | Downtrend (LH+LL) intact, or confirmed reversal (§4, S1 table) |
| M2 | Weekly Elliott position | weekly | Inside motive (1)/(3)/(5), or a completed (A)-(B)-(C) down; all 3 Elliott rules PASS (§2, M2 table) | S2 | Weekly Elliott position | weekly | Inside a falling motive wave, a completed 5-up, or (A)/(B)/(C); all 3 rules PASS (§4, S2 table) |
| M3 | Daily Dow direction | daily | Uptrend intact, pullback holding last HL, or confirmed reversal; no live triggered bearish daily pattern (§3, M3 table) | S3 | Daily Dow direction | daily | Downtrend intact, bounce holding below last LH, or confirmed reversal; no live triggered bullish daily pattern (§5, S3 table) |
| M4 | Daily wave + Tide | daily | Inside motive 1/3/5 **AND** daily MACD uptick/flat-after-down, visual read agreeing (§3, M4a/M4b) | S4 | Daily wave + Tide | daily | Valid bearish wave position **AND** daily MACD downtick/flat-after-up, visual read agreeing (§5, S4a/S4b) |
| M5 | Hourly Elliott setup | 1-hour | One of BUY‑1…BUY‑5 identified, all 3 Elliott rules PASS with arithmetic (§4) | S5 | Hourly Elliott setup | 1-hour | One of SELL‑1…SELL‑5 identified, all 3 rules PASS with arithmetic (§6) |
| M6 | Price-action trigger | 1-hour | A named PAPA buy setup has **TRIGGERED** at a level — a close through it, not an observation, not on a gap alone (§5) | S6 | Price-action trigger | 1-hour | A named PAPA sell setup has **TRIGGERED**, same conditions (§7) |
| M7 | SMM Bull Hat | daily+1H | Step 1 BUY **AND** Step 2 BUY (§6) | S7 | SMM Bear Hat | daily+1H | Step 1 SELL **AND** Step 2 SELL (§8) |
| M8 | Reward ÷ Risk | 1-hour | **> 3**, structurally valid stop (§7) | S8 | Reward ÷ Risk | 1-hour | **> 3**, structurally valid stop (§9) |

Both playbooks note the direction lock explicitly: "M1 AND M2 AND M3 AND M4 must all pass
before the hourly chart is opened" (BUY §3) / "S1 AND S2 AND S3 AND S4 must all pass
before the hourly chart is opened" (SELL §5) — the M5–M8/S5–S8 gates are never evaluated
if the higher-timeframe gates fail.

---

## 5. Five independent confirmation groups — CONFLICT, flagged not resolved

**This concept does not exist in the same form in the primary swing playbooks.** It comes
from the cross-check documents only:

**buy-conditions.md, "Independent confirmation groups" section (exact wording):**
> "After all mandatory gates and the chosen route pass, require at least four of these
> five groups. Do not count multiple signals from one group as independent."
>
> 1. Structure and level 2. EMA and Fibonacci 3. Momentum 4. Price action and pattern
> 5. Participation and regime

sell-conditions.md mirrors this exactly (bearish wording) in its own "Independent
confirmation groups" section.

**The primary Weekly→Daily→1H swing playbooks have no "N of 5 groups" pass/fail rule at
all.** Their equivalent grading mechanism is a **continuous 100-point scorecard** run
"only after all eight gates have passed... it decides how strongly to act, never whether
to act" (`BUY_Signal_Playbook_Weekly_Daily_1H.md` §9; SELL §11), organized into five
**blocks**, not groups, each worth a fixed point total:

| Block | BUY topic (points) | SELL topic (points) | Locator |
|---|---|---|---|
| A | Higher-timeframe quality (20) | Higher-timeframe quality (20) | BUY §9 Block A / SELL §11 Block A |
| B | Wave quality (25) | Wave quality (25) | Block B |
| C | PAPA price action (20) | PAPA price action (20) | Block C |
| D | Pattern, EMA and Fibonacci (20) | Pattern, EMA and Fibonacci (20) | Block D |
| E | Indicators (15) | Indicators (15) | Block E |

Verdict is then read off a score table (80–100 / 65–79 / 50–64 / <50), never a "≥4 of 5"
binary count (§10 BUY "The verdict grades"; §12 SELL).

**The blocks and the cross-check's five groups do not map one-to-one.** For example the
cross-check's "Participation and regime" (volume + DMI/ADX) is split across the swing
playbook's Block C (a DMI line inside PAPA) and Block B (a volume line inside wave
quality) rather than living in one block. Likewise "Structure and level" from the
cross-check spans the swing playbook's mandatory gates M1–M6 rather than being a scored
block at all.

**Decision needed from the strategy owner (per task instructions, not resolved here):**
whether the swing YAML should (a) implement only the swing playbook's 100-point/5-block
scorecard as governing, (b) also implement a "≥4 of 5" gate borrowed from the positional
cross-check as an additional filter, or (c) treat the cross-check's grouping as
informative-only since it describes a different (monthly/weekly/daily) document. This
office does not pick one — see §13, conflict #3.

---

## 6. Vetoes

The primary swing playbooks express this as **"what kills a live signal"**, not a
separate "vetoes" list — both are reproduced, and the cross-check's veto list (from the
positional documents) is shown alongside since its wording is more exhaustive and the
task requires capturing everything documented under this heading.

### Primary source — BUY: "What kills a live buy signal"
*Locator: `BUY_Signal_Playbook_Weekly_Daily_1H.md` §12.*

- An hourly close below the origin of wave 1 (rule 1 breaks, count dead).
- Wave 4 entering wave 1's territory (rule 2 breaks, unless diagonal).
- Wave 3 failing to exceed wave 1's length (rule 3 breaks).
- A daily close below the last Higher Low (daily uptrend over, M3 gone).
- The weekly MACD histogram downticking (the Ocean has turned).
- Price closing back inside the pattern within a candle or two of the break.
- The break came only on the gap, with the rest of the session giving it back.
- The break came on thin hour-slot volume — wait for the retest.
- A completed five-wave up on the hourly — expect a corrective phase, stop adding.
- The BUY-3 wedge has already been retraced (history, not a signal).
- Reward ÷ risk fallen below 3 because price ran without entry (missed, not worse).

### Primary source — SELL: "What kills a live sell signal"
*Locator: `SELL_Signal_Playbook_Weekly_Daily_1H.md` §14.* Exact mirror of the above:
hourly close above origin of wave 1 down; wave 4 entering wave 1's territory; wave 3 down
failing to exceed wave 1's length; daily close above last Lower High; weekly MACD histogram
upticking; price closing back inside the pattern; break only on the gap down; thin
hour-slot volume on the break; a completed five-wave down; **a fifth-wave-extension
signature (5th-wave volume ≥ 3rd-wave volume) — "your top is not a top"**; a new price
extreme that is actually a b leg of an expanded flat, not a resumed trend; reward ÷ risk
fallen below 3.

### Cross-check — buy-conditions.md "Buy vetoes" (positional document, quoted list)

Monthly/weekly Dow not bullish; last monthly/weekly higher low broken; monthly/weekly
Elliott count invalid/ambiguous/terminal; bearish divergence with a mature fifth wave or
new high; rising ending diagonal / truncation risk / channel failure; daily trigger
intrabar, absent, stale, or already at target; required volume missing or below average;
price closes beyond 78.6% retracement or setup invalidation; EMA tangled and ADX shows a
range while a trend route is claimed; breakout promptly closes back inside the pattern;
reward/risk ≤ 3.00.

### Cross-check — sell-conditions.md "Sell vetoes" — mirror of the above (bearish wording)

### Where the two veto lists diverge (flag, not resolve)

The cross-check's "EMA lines are tangled and ADX shows a range while a trend route is
claimed" veto and its "monthly/weekly Elliott count invalid/ambiguous/terminal" veto have
**no directly matching line** in the primary swing playbook's kill-lists — the swing
playbook instead expresses the ADX condition as a WAIT rule inside its combination matrix
("Hourly ADX below 14, or flat under 25 → WAIT", §11 BUY / §13 SELL) rather than as a
veto that kills an already-live signal. Whether "ADX in a range while claiming a trend
route" should be encoded as a swing-playbook veto (killing a live signal) or only as a
pre-entry WAIT condition (blocking entry, per the combination matrix) is not stated by
either document and needs a strategy-owner decision — see §13.

---

## 7. Indicator specs required by these playbooks

Locator for the full settings table: `BUY_Signal_Playbook_Weekly_Daily_1H.md` §1.1 "What
you need, on all three timeframes"; `SELL...` §3 (identical table).

| Indicator | Setting | Status | Notes / locator |
|---|---|---|---|
| EMA | 5, 13, 26, 50 | DOCUMENTED | Standard formula `k = 2/(n+1)`, `EMA[i] = close[i]*k + EMA[i-1]*(1-k)` (`smm-ema-fibonacci-SKILL.md` §1). **Caution:** the source deck's "0.09 × close + 0.91 × prior" is explicitly stated to illustrate a ~21-period EMA only, "not the constant for every length" — do not hardcode it. |
| Bollinger Bands | 20-period middle SMA; **2 SD and 3 SD**, both required | DOCUMENTED | `papa-price-action-SKILL.md` §7; playbook data table row "Bollinger Bands 20, 2 SD and 3 SD". The *setup* is a band **failure** (wick pierces, close stays inside), not a touch — do not call a touch a failure unless the candle closed back inside. |
| MACD | 12, 26, close, 9 (line, signal, histogram) | DOCUMENTED | `smm-indicators-SKILL.md` §1, playbook data table. Warm-up ≈35 bars — never report a crossover inside it. |
| RSI | 14, **Wilder's smoothing** | DOCUMENTED | `smm-indicators-SKILL.md` §2 gives the exact Wilder recursion (`avg_gain = (prev*13 + gain)/14`, seeded with a simple 14-bar mean). Warm-up ≈15 bars. |
| Stochastic | 14, 3, 3 | DOCUMENTED | Raw %K over a 14-bar lookback, %K = 3-bar SMA of raw %K, %D = 3-bar SMA of %K (`smm-indicators-SKILL.md` §2). Warm-up ≈17 bars. |
| DMI / ADX | 14, 14 | DOCUMENTED — **Wilder confirmed** | `papa-price-action-SKILL.md` §9: "Use Wilder's smoothing for +DI, −DI and ADX. Discard the first ~28 bars." |
| Volume average — rolling | 20-period flat average | DOCUMENTED | Playbook §1.1 table row "Average volume: 20-period, plus the hour-slot average on the 1-hour chart." |
| Volume average — same-session-slot (hourly only) | Mean volume of the **same hour of day** over the **last 10–20 sessions** | DOCUMENTED (approximate — range, not fixed N) | `BUY...` §1.2 "Volume on the 1-hour chart — the correction that matters"; `SELL...` §3.1. The exact N within 10–20 is a PROJECT_DEFAULT decision (§13). A trigger candle qualifies on volume only when it clears its **hour-slot** average, not the flat one. |
| Zig-zag swing detector | ~5% weekly, 2–3% daily, **1–1.5% hourly** | DOCUMENTED (approximate — ranges) | Playbook §1.1 table row "Zig-zag swing detector"; consistent with `smm-chart-analysis-SKILL.md` §0 for weekly/daily. Exact thresholds per timeframe are PROJECT_DEFAULT (§13). |
| Fibonacci anchor rule | Uptrend: anchor low→high, levels measured **down from the high** = support. Downtrend: anchor high→low, levels measured **up from the low** = resistance. Ratios 23.6/38.2/50/61.8/78.6%. | DOCUMENTED | `smm-ema-fibonacci-SKILL.md` §5. "Anchor to the most recent clean impulse leg, wick to wick, and be consistent" — which leg counts as "clean" depends on the same zig-zag threshold above. |

---

## 8. Reward/risk requirement — exact wording and threshold

**The requirement is strictly `> 3`, not `>= 3`, in every source document that states it.**

- `smm-decision-sheet-SKILL.md` §7: *"Risk to reward — must be **above 3** to enter the trade."* And immediately below: `Ratio = Reward / Risk    Enter only if > 3`.
- `BUY_Signal_Playbook_Weekly_Daily_1H.md` §7 "Stage 6 — Gate M8": `Ratio = Reward / Risk → ENTER ONLY IF > 3`, followed by "Show the arithmetic. **2.6 fails. Do not round up.**"
- `SELL_Signal_Playbook_Weekly_Daily_1H.md` §9 "Stage 6 — Gate S8": identical wording, mirrored formula (`Reward = Entry − Target`, `Risk = Stop Loss − Entry`).
- `buy-signal-analysis\references\buy-conditions.md`, "Risk gate": *"Risk must be positive and reward divided by risk must be strictly greater than 3.00."*
- `sell-signal-analysis\references\sell-conditions.md`, "Risk gate": identical, bearish formula.
- `gue-ending-diagonal-SKILL.md` §4: *"Carry the SMM one: reward ÷ risk must be above 3 to enter."*

**CONFLICT with project governance:** `stock-platform/AGENTS.md`, "Risk Boundaries"
section states: *"Minimum normalized reward/risk gate: `reward / risk >= 3.0`."* This is
an inclusive `>=`, directly contradicting every source document above, all of which use a
strict `>` and explicitly warn against rounding a failing ratio up. This is recorded as
an open conflict in §13 (#1) — not resolved here.

---

## 9. Gap/first-candle rule

*Locator: `BUY_Signal_Playbook_Weekly_Daily_1H.md` §1.3 "Gaps, the first candle and the
last candle"; `SELL_Signal_Playbook_Weekly_Daily_1H.md` §3.1 "The three intraday
corrections" (same content, folded into that subsection).*

Exact wording: *"The overnight gap lands inside the first hourly candle of the session.
That candle can close through a level purely on the gap, with no intraday participation
at all. **A gap candle is not a breakout candle.**"*

Required follow-up, one of two methods (the source does not mandate a single one — see
§13 conflict #8):

1. *"Either wait for the second hourly candle of the session to confirm the level"*, or
2. *"measure the break against the previous session's close and say you did."*

This rule is cross-referenced explicitly inside multiple setup checks, e.g. BUY‑1 check 6:
*"If that close is the session's first candle and the level was cleared by the overnight
gap, wait for the second candle"*; and again in both kill-lists (§12 BUY / §14 SELL: "The
break came only on the gap, with the rest of the session giving it back").

The same discipline extends to PAPA setups that are inherently open-relative on the
hourly chart — the **bulls/bears counter attack** and **gap up/down** rows are
"session-open events by construction" on the hourly (BUY §5 / SELL §7): read them only on
the 09:15 candle and require the follow-up candle before acting.

---

## 10. NSE final 15-minute session stub

*Locator: `BUY_Signal_Playbook_Weekly_Daily_1H.md` §1.3; `SELL_Signal_Playbook_Weekly_Daily_1H.md` §3.1.*

Exact wording: *"The last candle of the session is often a partial hour (many charting
platforms print a 15-minute stub at the end of an Indian session). Either merge it into
the preceding candle or exclude it, and say which — a 'reversal candle' that is really
fifteen minutes long is not a reversal candle."*

The playbook explicitly leaves the choice open (merge vs. exclude) provided the choice is
disclosed — it does not mandate one. For a deterministic, non-interactive pipeline this is
a PROJECT_DEFAULT decision the strategy owner must make and record (§13, #7). It sits
alongside the general "current candle still forming" discipline stated in the same
section: *"Say when the current hourly candle is still running. Its close decides most
triggers... on this timeframe you are always within an hour of one."*

---

## 11. Elliott wave rules relevant to the swing analysis

### The 3 hard impulse rules
*Locator: `gue-elliott-wave-SKILL.md` §1 "The three rules — never broken"; re-stated with
identical wording inside both swing playbooks (BUY §2 "Test the three rules with
arithmetic", SELL §4).*

| # | Rule | A violation means |
|---|---|---|
| 1 | Wave 2 never retraces 100% of wave 1 | The wave-1 label is in the wrong place |
| 2 | Wave 4 never enters wave 1's price territory | Wrong count — **or** it is a diagonal triangle, where overlap is normal |
| 3 | Wave 3 is never the shortest of waves 1, 3 and 5 | Wrong count. Wave 3 may be the middle one; it cannot be shortest |

All three must be "tested with arithmetic and reported" — "Valid" is explicitly rejected
as a substitute for a numeric test (`gue-elliott-wave-SKILL.md` §1 and §11 "Honesty
rules"; both playbooks' M2/S2 and M5/S5 sections repeat "test the three rules with
arithmetic and print the numbers").

### Ending-diagonal (EDT) requirements
*Locator: `gue-elliott-wave-SKILL.md` §3 "Motive waves — Diagonal triangle";
`gue-ending-diagonal-SKILL.md` §0–§3.*

- **Sub-wave count:** waves 1, 3, 5 of the diagonal have **three** sub-waves each (not
  five, unlike a normal impulse) — `gue-elliott-wave-SKILL.md` §3.
- **Overlap:** wave 4 **almost always overlaps** wave 1 — this is the diagonal's defining
  exception to hard rule 2.
- **Converging boundaries:** "two boundary lines through actual pivots, extended forward.
  Report both slopes and confirm they converge. A wedge whose lines diverge is not this
  setup" (`gue-ending-diagonal-SKILL.md` §0, repeated in both playbook §4.5/§6.4).
- **Wave-5/C location:** the diagonal is "typically wave 5 or wave C, at the termination
  point of a larger pattern" (`gue-elliott-wave-SKILL.md` §3) — the setup is invalid
  anywhere else in the count.
- **Breakout close:** entry requires the close **through** the boundary (EDT‑BO for a
  falling wedge / EDT‑BD for a rising wedge) — an unclosed touch is "observed", not
  "triggered" (`gue-ending-diagonal-SKILL.md` §7 "Honesty rules": "Observed is not
  triggered... the close through the boundary is the trigger").
- **Volume:** above-average (playbook: above-hour-slot-average) volume on the breakout
  candle is a documented **MUST**, not a supporting condition.
- **Post-completion behaviour:** "once it ends, price retraces the entire diagonal" —
  this is the stated basis for target 1 in both BUY‑3/SELL‑2.

### Current forming wave vs. completed wave

No source gives this as a single formal rule; it is enforced operationally, consistently,
in three ways across the material:

1. **A wave is treated as "complete" only once the *next* wave's trigger has fired.**
   E.g. BUY‑1 check 2 requires "Wave 2 complete — it has ended, and price has turned up
   from it" as a precondition, and the actual completion evidence is the check‑6 trigger
   (a close above the wave‑1 high). The playbooks do not offer an independent test for
   "wave 2 has ended" other than the subsequent structural break.
2. **The currently-printing bar is never final.** "Say when the current hourly candle is
   still running. Its close decides most triggers" (`BUY...` §1.3); "Say when the most
   recent candle is still forming — its close decides most triggers" (`gue-elliott-wave-SKILL.md`
   §11, and repeated near-verbatim in `gue-ending-diagonal-SKILL.md`, `smm-*` and
   `papa-*` skills' honesty rules).
3. **A completed structure whose target has already been met is explicitly downgraded to
   "history, not a live signal"** across every source ( `gue-elliott-wave-SKILL.md` §11;
   `gue-ending-diagonal-SKILL.md` §7: "A diagonal already retraced is history, not a
   signal"; `smm-chart-patterns-SKILL.md` §7; `papa-decision-sheet-SKILL.md` §6).

---

## 12. Pattern catalog

Trigger wording quoted where the source gives an exact completed-close rule. "Prior trend
required" and "location" are the conditions that make a shape count at all — every skill
explicitly states that a pattern without its required trend/location is not to be
reported as the named pattern.

### 12.1 Candlestick patterns (single/multi-candle)
*Locator: `smm-chart-analysis-SKILL.md` §4–§5; mirrored/extended in
`papa-price-action-SKILL.md` §1; buy/sell-conditions.md "Price action definitions".*

| Pattern | Trigger (completed-close rule) | Required prior trend/location | Volume | Failure / status | Measurable now? |
|---|---|---|---|---|---|
| Bullish/Bearish Candle | `c>o` (bull) / `c<o` (bear), body ≥ ~60% of range, small opposite wick | none specific | supportive | n/a | DOCUMENTED (approximate "~60%" — PROJECT_DEFAULT to pin exact %) |
| Hammer | `min(o,c)-l ≥ 2×abs(c-o)` and `h-max(o,c) ≤ ~0.6×abs(c-o)` | **only** at bottom of a downtrend | — | Same shape mid-trend/at top is not this pattern | DOCUMENTED — exact multiplier 2×; "~0.6×" upper-wick cap is approximate → PROJECT_DEFAULT |
| Inverted Hammer / Shooting Star | mirror of hammer, `h-max(o,c) ≥ 2×abs(c-o)` | only at top of an uptrend (called Shooting Star there) | heavy volume strengthens it | — | DOCUMENTED |
| Hanging Man | hammer shape at **top** of uptrend | requires a **following red candle** to count | — | Without the follow-up red candle it does not count | DOCUMENTED |
| Bullish/Bearish Piercing | c2 closes between c1's median and o1 (bull) / mirror (bear) | 2-candle at a level | — | — | DOCUMENTED (`median = (o+c)/2` of body, exact) |
| Bullish/Bearish Engulf | c2 body fully engulfs c1 body, opposite colour | at a level | — | — | DOCUMENTED |
| Morning Star / Evening Star | 3-candle: big opposite-colour c1, small neutral c2 (gap), c3 closes beyond c1's median | at a level; skip EMA check-3 on SMM decision sheet when this fires | — | — | DOCUMENTED |
| Three White Soldiers / Three Black Crows | 3 long same-colour candles, each opening inside prior body, closing near own extreme | — | — | Trigger = renewed same-direction candle after a pullback into 2nd candle's range (`papa-decision-sheet-SKILL.md` §2/§3) | DOCUMENTED |
| Dark Cloud Cover | bearish candle gaps up, closes below prior bullish candle's median, needs follow-through | at resistance / top | — | — | DOCUMENTED |
| Doji family (gravestone/dragonfly/long-legged/four-price) | `o≈c`; sub-type by wick shape | — | — | Neutral — no direction alone | DOCUMENTED, "≈" tolerance UNRESOLVED (no numeric threshold given anywhere) |
| Spinning Top / Harami / High Wave | small/tiny body, various wick shapes | — | — | Neutral | UNRESOLVED — "small"/"tiny" never quantified |

### 12.2 Chart (formation) reversal patterns
*Locator: `smm-chart-patterns-SKILL.md` §2–§3; `buy-conditions.md`/`sell-conditions.md`
pattern-measurement tables.*

| Pattern | Trigger | Prior trend | Location | Volume | Failure condition | Measurable now? |
|---|---|---|---|---|---|---|
| Head & Shoulder | **close below the neckline** | prior uptrend required | top | should fall through head/shoulder, expand on breakdown | close back inside within 1–2 bars; "often runs hard the other way" if it fails | DOCUMENTED except `P1≈P3 within ~5%` (approximate → PROJECT_DEFAULT) |
| Double Top | **close below the neckline** | prior uptrend | top, two comparable highs | supportive | If 2nd top far below 1st → it's an LH, not a double top | DOCUMENTED except tolerance: "`|P1−P2|/P1 < ~3%`" (`smm-chart-patterns-SKILL.md`) / "within about 3 percent" (buy-conditions.md) — convergent but approximate → PROJECT_DEFAULT |
| Inverted H&S | **close above the neckline** | prior downtrend required | bottom | light through head, expand on breakout | — | DOCUMENTED |
| Double Bottom | **close above the neckline** | prior downtrend | bottom, two comparable lows | — | 2nd bottom **above** 1st = stronger version; a spring (undercut + fast recovery) still counts | DOCUMENTED, same ~3% tolerance caveat |
| Cup & Handle | **breakout above the pivot on above-average volume** | rounded base required | rim = pivot | **MUST**: low in cup bottom + handle, expand at breakout — 2 explicit conditions | handle deep or into lower half of cup invalidates it | DOCUMENTED |

Universal target rule (`smm-chart-patterns-SKILL.md` §1): `D` = pattern height measured
to the break point; target = neckline ± D, projected in the direction of the break;
"minimum, not a promise," valid only after the break.

### 12.3 Continuation patterns

| Pattern | Trigger | Prior trend / structure | Failure condition | Measurable now? |
|---|---|---|---|---|
| Bullish Flag & Pole | close above the flag top | sharp near-vertical pole, then a **tight** box drifting sideways/down | "the flag must be SHORT relative to the pole, and tight" — **no numeric ratio given anywhere** | UNRESOLVED — flagged explicitly in the source itself as the "rule that disqualifies most candidates," with no number |
| Bearish Flag & Pole | close below the flag bottom | mirror | Same — drift against trend "is what makes it a flag rather than a bottom" | UNRESOLVED, same reason |

### 12.4 PAPA formations
*Locator: `papa-price-action-SKILL.md` §3–§8; `papa-decision-sheet-SKILL.md` §2–§3 (the
10 BUY + 10 SELL setup rows, reproduced verbatim inside the swing playbooks §5/§7).*

| Formation | Observation | Trigger | Stop | Volume/other | Measurable now? |
|---|---|---|---|---|---|
| Bull/Bear Counter Attack | price opens below support / above resistance | re-enters above/below the level **in the same or a later candle** | counter-attack candle low/high | supportive: BBC failed + heavy volume | DOCUMENTED |
| Sandwich breakout/breakdown | alternating red/green candles in a compact range, no candle-count limit | close above/below previous candle **and** the range edge | opposite side of sandwich | — | DOCUMENTED |
| Accumulation (bottom) / Distribution (top) | sideways, many neutral candles at the level, **no major follow-up** in the trend's direction | — (context read, not a trigger) | — | "no major follow-up" is qualitative | UNRESOLVED — no numeric bar-count or range-width given |
| Tweezers (top/bottom) | 2 adjacent candles with highs/lows at "almost the same level" | — | — | only meaningful at trend extremes | UNRESOLVED — "almost the same" not quantified |
| Mother candle (reversal/continuation, bull/bear) | a **bigger** candle; ≥3 following candles trade **within** its high–low | later close beyond the mother candle's high/low | opposite extreme of mother candle | location (support/resistance vs. mid-trend) determines reversal vs. continuation | DOCUMENTED — N=3 subsequent candles is an exact number; "bigger" (vs. recent average) is UNRESOLVED |
| Genuine BO/BD | a **shakeout** occurs before the real break | follow-up candle closes beyond the break level | breakout/breakdown candle's opposite extreme | Ungali setup supportive (INFERRED) | DOCUMENTED (mechanism); "shakeout" itself is on `source-register.md`'s subjective-terms list |
| Fake BO/BD | **no** shakeout before the break; price re-enters | follow-up candle closes beyond the failed-break candle | that candle's opposite extreme | divergences + heavy volume supportive | DOCUMENTED; asymmetry explicit: fake breakdown = BUY setup, fake breakout = SELL setup |
| Gap up/down | opens beyond the level and **sustains** the gap | "enter after follow-up" | breakout candle extreme or beyond the gap level | Ungali supportive | DOCUMENTED mechanism; "sustains" not quantified (bars/percent) → UNRESOLVED |
| Rounding bottom/top | multiple big same-colour candles with **no strong follow-through**, mostly neutral candles forming a base/top | strong close beyond the range | lowest/highest of the range candles | — | DOCUMENTED mechanism; "big"/"strong" unquantified → UNRESOLVED |
| Weapon (decisive candle) | bullish candle with **no lower wick** / bearish with **no upper wick** | "taken out" = price trades through its low/high | — | used as the double-top/bottom trigger reference | DOCUMENTED |

---

## 13. Open conflicts and unresolved items

1. **Reward/risk threshold — direct conflict.** `AGENTS.md` "Risk Boundaries": `reward /
   risk >= 3.0`. Every technical source (`smm-decision-sheet-SKILL.md` §7; both swing
   playbooks §7/§9; `buy-conditions.md`/`sell-conditions.md` "Risk gate";
   `gue-ending-diagonal-SKILL.md` §4) states strictly `> 3` and explicitly warns "2.6
   fails, do not round up." **Decision needed:** which threshold and comparator
   (`>` vs `>=`) governs the swing strategy YAML's M8/S8 gate.

2. **Gate-ID collision with existing YAML.** `stock-platform/strategies/buy-signal-playbook.yaml`
   and `sell-signal-playbook.yaml` already use rule IDs `BSP-M1…M8` / `SSP-S1…S8` for the
   **positional** playbook (`playbooks/BUY_Signal_Playbook.md`, Monthly→Weekly→Daily).
   This task's source, the **swing** playbook (`_Weekly_Daily_1H` variant), reuses the
   identical gate letters M1–M8/S1–S8 for a different timeframe set (Weekly→Daily→1H)
   and different named setups (BUY‑1…BUY‑5 vs. Route A–E). **Decision needed:** assign a
   distinct strategy id and rule-id prefix for the swing variant (e.g.
   `BSP-SWING-M1`) so it does not collide with or get confused for the existing
   positional YAML, per `AGENTS.md` rule "Preserve the original strategy and any
   optimized variant as separate, versioned definitions."

3. **"5 independent confirmation groups / ≥4 of 5" vs. the swing playbook's 100-point/5-block
   scorecard — structural mismatch, not resolved.** Full detail in §5. The "≥4 of 5"
   binary rule exists only in the cross-check (positional) documents; the primary swing
   playbook uses continuous point scoring across differently-defined blocks. **Decision
   needed:** which mechanism (or both, and how combined) governs the swing YAML's
   confirmation logic.

4. **ADX no-trend threshold — self-disclosed deviation, scope unclear.** `papa-price-action-SKILL.md`
   §9 and both cross-check documents ("Participation and regime" group) use **ADX < 20 =
   no trend**. The swing playbooks override this to **ADX < 14** specifically inside the
   hourly PAPA-trigger section, self-labeled: *"The operating threshold in this playbook
   is 14, not 20... Running it at 14 catches trends earlier... so the slope now does the
   work the level used to"* (`BUY...` §5; `SELL...` §7). Neither playbook states whether
   14 also applies to weekly/daily ADX reads elsewhere in the same document (none of the
   weekly/daily gates M1–M4/S1–S4 reference ADX at all). **Decision needed:** confirm the
   14-threshold's scope is hourly-only, and confirm whether this project adopts it as
   PROJECT_DEFAULT for the swing strategy specifically (it would not apply to the
   positional strategy, which the existing YAML does not encode ADX for either).

   **RESOLVED (2026-09-11), as a disclosed `PROJECT_DEFAULT`, scoped narrowly:** the swing
   (Weekly→Daily→1H) hourly combination-matrix WAIT check ("Hourly ADX below 14, or flat
   under 25 → WAIT", `BUY...` §11 / `SELL...` §13) uses **14** (and **25** for the
   flat-ceiling half of that same rule), implemented in
   `features/hourly-conditions.js`'s `evaluateHourlyAdxCondition`, thresholds in
   `config/parameters.yaml` (`swing_hourly_adx_wait_below`, `swing_hourly_adx_flat_ceiling`).
   Reasoning, per `AGENTS.md`'s own Evidence Priority order (§ "Evidence Priority" —
   "dedicated setup checklist or decision sheet" outranks "concept document dedicated to
   the subject"): the swing playbooks *are* the dedicated setup checklist for this exact
   strategy and this exact timeframe, and their 14/25 reading is not a copy error but a
   self-aware, explicitly reasoned override of the general concept document's 20 — the
   playbook argues its own case for the deviation in the text quoted above. That argument
   does not extend to any other context, so this decision changes nothing else: the
   general PAPA/ADX **20** no-trend reading is untouched and remains what any *other*
   future rule should use (weekly/daily ADX reads, the positional BSP-/SSP- strategy, or
   any general PAPA no-trend read) — no such rule exists in this codebase today, so there
   is nothing else to update. Scope is explicitly **hourly-only**, matching this entry's
   own unresolved-scope note above: the weekly/daily gates M1–M4/S1–S4 still reference no
   ADX condition at all, and this resolution does not add one. This is a strategy-owner
   decision made by the acting engineering agent in this session, per this project's
   established practice of disclosing rather than escalating scoped, reversible
   `PROJECT_DEFAULT` picks (see e.g. conflict #6, #7, #9's own resolutions) — a human
   reviewer can revisit it by editing the two parameters above; nothing about this
   decision is hardcoded or hidden.

5. **Zig-zag swing-detection thresholds are ranges, not fixed values**, at every degree:
   ~5% weekly, 2–3% daily, 1–1.5% hourly (`BUY...` §1.1 table; consistent with
   `smm-chart-analysis-SKILL.md` §0). **Decision needed:** pin exact percentages per
   timeframe for deterministic pivot detection.

6. **Hour-slot volume average lookback is a range**: "the last 10–20 sessions" (`BUY...`
   §1.2; `SELL...` §3.1). **Decision needed:** pin exact session count N.

7. **NSE final 15-minute stub handling is explicitly left open** ("merge it into the
   preceding candle or exclude it, and say which" — `BUY...`/`SELL...` §1.3/§3.1).
   **Decision needed:** pick merge or exclude as the deterministic default.

8. **Gap/first-candle confirmation method is explicitly left open** (wait for the second
   hourly candle, **or** measure the break against the prior session's close — same
   locator as #7). **Decision needed:** pick one deterministic method, or encode both
   with a documented precedence.

9. **Ending-diagonal minimum candle count is a range**: "in practice at least fifteen to
   twenty hourly candles" (`BUY...` §4.5; `SELL...` §6.4) — a swing-playbook-only
   addition, absent from the generic `gue-ending-diagonal-SKILL.md`. **Decision needed:**
   pin exact N.

10. **Setup taxonomy mismatch, not a contradiction but a trap for the architect.** The
    swing playbook's BUY‑1…BUY‑5 (Wave 3 Ignition, Wave 4 Completion, Ending Diagonal
    Reversal, Wave 2 Pullback, Continuation Add) is an Elliott-degree taxonomy at the
    1‑hour gate (M5). `buy-conditions.md`'s Route A–E (Daily wave 3 launch, Trend
    pullback resumption, Bullish breakout continuation, Support reversal, Bullish ending
    diagonal reversal) is a **different document's** daily-degree taxonomy for the
    positional playbook, and Routes C/D bundle several named PAPA/chart-pattern setups
    that the swing playbook instead scores under its separate PAPA-trigger gate (M6).
    Flagging so the architect does not merge or alias these two ID sets.

11. **Bull/Bear Hat Step 2 crossover choice is underspecified in the primary source** —
    both swing playbooks say only "name the actual crossover" for the daily
    Stochastic/RSI signal (BUY §6; SELL §8) without fixing which exact crossover rule to
    use. The existing positional YAML (`BSP-M7B`/`SSP-S7B`) already made and disclosed an
    implementation choice for the positional variant (Stochastic %K/%D cross from
    <20/>80, OR RSI cross through 40/60), explicitly noting it is "not an extracted
    literal rule." **Decision needed:** whether the swing (1‑hour) variant's M7/S7 Step 2
    reuses that same choice or needs its own (the swing playbook's oscillator is on the
    1‑hour chart, not daily, so the positional choice cannot simply be copied verbatim).

12. **Minor internal inconsistency in a cross-check source, not blocking.**
    `papa-decision-sheet-SKILL.md`'s own frontmatter says "all eighteen named setups" but
    its BUY (10 rows) + SELL (10 rows) tables list 20 distinct setups — consistent with
    the swing playbook's "the ten BUY setups" / "the ten SELL setups" (§5/§7). Noted for
    completeness; does not affect extraction since all 20 rows were captured in §12.4.

13. **Double-top/H&S peak-comparability tolerance converges around ≈3% but is always
    qualified as approximate** (`smm-chart-patterns-SKILL.md` "< ~3%"; `buy-conditions.md`/
    `sell-conditions.md` "within about 3 percent"). **Decision needed:** pin an exact
    percentage.

14. **Flag-and-pole "short and tight" proportion has no numeric ratio anywhere in any
    source**, and `smm-chart-patterns-SKILL.md` §4 flags this itself as "the rule that
    disqualifies most candidates" without giving a number. **UNRESOLVED — do not invent a
    ratio; keep as MANUAL_REVIEW / scored evidence until a project default is set.**

15. **Inferred-vocabulary terms (BBNC, Ungli/Ungali, BKP, BKT, "weapon") are consistently
    flagged INFERRED across every source that uses them** — `gue-ending-diagonal-SKILL.md`
    §1, `papa-decision-sheet-SKILL.md` §1, and both swing playbooks all state the same
    readings and all flag them as not expanded on the original checklists. Not a
    conflict between sources (all agree), but must not be silently promoted to
    `DOCUMENTED` status in the YAML — keep `INFERRED` and retain the original abbreviation
    per `AGENTS.md` provenance rules.

16. **Inherited, not newly introduced:** the swing playbooks defer to `AGENTS.md`'s
    provisional 8%/10% monthly-loss-stop conflict (already recorded in
    `strategies/smm.yaml` `SMM-MONTHLY-001` and `references/source-register.md`) without
    adding any swing-specific position on it. No new information from this extraction
    changes that entry.

17. **ADX "trending bands" for RSI are stated as approximate** ("roughly 40–80... the 40
    line acts as support" — `smm-indicators-SKILL.md` §2) but the swing playbook's
    scorecard adopts the 40/60 lines as exact scoring thresholds (Block A / Block E,
    both playbooks) without re-flagging the "roughly" qualifier. Treat the 40/60
    scorecard usage as the swing playbook's own `DOCUMENTED` choice (it is explicit and
    numeric there), but note the underlying source concept is approximate.

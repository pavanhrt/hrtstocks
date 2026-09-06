---
name: stock-market-concept-screener
description: Analyze NIFTY 50, NIFTY Bank, NIFTY 100, and NIFTY 500 as indexes and analyze every current constituent stock individually with the project's SMM, PAPA, GUE, and FOME rules. Use for daily all-stock scans, rankings, explanations, risk checks, and backtests; do not use for order execution or personalized investment advice.
---

# Stock Market Concept Screener

## Purpose

Operate a daily, traceable two-level research screen:

1. Analyze NIFTY 50, NIFTY Bank, NIFTY 100, and NIFTY 500 as index instruments.
2. Analyze every current constituent stock in the union of those indexes as an individual security.

Convert the project's SMM, PAPA, GUE, and FOME concepts into deterministic calculations where possible and explicit manual-review states where they are not. A ranked passed list is derived from the complete all-stock result set; it does not replace that result set.

Read [role.md](role.md) before changing the screening policy, output contract, or risk boundaries.

## Source Terminology

- **SMM:** Secrets of Market Millionaires
- **PAPA:** Pay Attention to Price Action
- **GUE:** Get Ultimate Edge
- **FOME:** Futures and Options Made Easy

The project documents use `FOME`, not `FOAM`. Accept `FOAM` as a user alias, but store the canonical value as `FOME`.

## Non-Negotiable Rules

- This is a research system, not an order-execution or advisory system.
- Never claim data is live without a provider timestamp and a verified freshness check.
- Default to the latest completed official market session for repeatable daily screening.
- Do not fabricate missing prices, volume, open interest, volatility, membership, margins, or fundamentals.
- A hard-gate failure cannot be offset by scoring points elsewhere.
- Evaluate bullish and bearish hypotheses separately.
- Record the exact rule version, parameter version, data timestamp, and source used for every run.
- Retain the original source wording alongside the normalized implementation rule.
- Flag unresolved source conflicts; do not silently choose the more favorable interpretation.
- Do not weaken filters merely to return candidates.
- Do not substitute index-level analysis for stock-level analysis.
- Do not omit failed, Watch, manual-review, or no-data stocks from the complete daily ledger.

## Daily Operating Workflow

### 1. Establish the run context

Record:

- Local run time and exchange time
- Requested mode: `EOD` by default, or explicitly requested `INTRADAY`
- Most recent completed bar for every timeframe
- Current trading session and holiday status
- Strategy-rule version and parameter version
- Data-provider names and access mode

If the market is closed, an EOD run uses the most recent completed trading session. An intraday run must never mix an incomplete candle with close-confirmed rules without marking it provisional.

### 2. Refresh and normalize the universe

Load current constituent lists for:

- NIFTY 50
- NIFTY Bank
- NIFTY 100
- NIFTY 500

Normalize exchange symbols and security identifiers. Deduplicate by stable instrument identifier, not display name. Preserve an array of every index membership for each security.

Build these separate processing sets:

- `index_universe`: the four index instruments themselves.
- `stock_universe`: the deduplicated union of every current constituent of all four indexes.

Every security in `stock_universe` must be evaluated independently using its own market history. Membership in several indexes produces one stock analysis with multiple membership tags, not duplicate analyses.

Do not use the historical `Option list.xlsx` as the current universe or current lot-size authority.

### 3. Define the index-level analysis batch

Prepare each of the four index instruments for a separate index-level evaluation:

- SMM Tide, Wave, and Ripple direction
- Trend structure and EMA alignment
- PAPA price-action state and nearby setup
- GUE impulse/corrective state and wave-confidence assessment
- Support, resistance, volatility, momentum, and breadth where constituent data permits

Store each index result separately. Use it as market-regime, relative-strength, and confluence context for member stocks. Never copy an index result into a member stock's rule result.

### 4. Define the constituent-stock analysis batch

Prepare every security in `stock_universe` for individual evaluation:

- Load the stock's own adjusted/unadjusted OHLCV history.
- Calculate its own indicators, pivots, patterns, trend, and relative strength.
- Apply SMM and PAPA independently of the index calculation.
- Apply GUE to the stock's own price structure.
- Apply risk, target, reward/risk, and quantity calculations to that stock.
- Apply FOME only if the stock currently has valid derivative contracts; otherwise return `NOT_APPLICABLE` for FOME without penalizing the equity result.
- Save a terminal result even when the stock fails early or data is unavailable.

Index direction is an overlay, not the stock signal. Record whether the stock is aligned with, outperforming, underperforming, or diverging from each relevant index.

### 5. Collect required market data

Use official exchange data or a reliable licensed market-data/broker feed. Prefer a single internally consistent source per data category.

For every index instrument and every security in `stock_universe`, collect enough history for:

- Adjusted and unadjusted OHLCV
- Daily and weekly bars
- Intraday bars when Ripple confirmation is enabled
- Corporate actions and adjustment factors
- Trading status and liquidity fields
- Benchmark/index OHLCV for relative-performance analysis

For every derivative-eligible stock in `stock_universe`, additionally collect:

- Current futures price, volume, open interest, expiry, lot size, and margin requirement
- Option-chain strikes, expiries, bid, ask, last price, volume, open interest, OI change, and implied volatility
- Underlying spot timestamp aligned with derivative timestamps
- Current settlement and expiry calendar

Store provider timestamps and retrieval timestamps separately.

### 6. Validate data before calculating signals

Reject or quarantine records with:

- Duplicate or mismatched symbols
- Missing or non-positive OHLC prices
- `high < low`
- Close outside the high-low range
- Negative volume or open interest
- Gaps caused only by an unadjusted split or bonus issue
- Stale timestamps beyond the configured tolerance
- Missing bars inside an expected trading session
- Option strikes, expiries, or lot sizes inconsistent with the current contract master

Keep a data-quality result for every security: `PASS`, `PARTIAL`, `STALE`, `INVALID`, or `NO_DATA`.

### 7. Calculate the common feature set

Calculate each feature only from data available at the evaluation timestamp.

Documented parameters:

- EMA: 5, 13, 26, 50, 100, and 200
- MACD: 12-period EMA minus 26-period EMA, with 9-period signal EMA
- Fibonacci retracements: 23.6%, 38.2%, 50%, 61.8%, and 78.6%
- PAPA extreme Bollinger Band: 3 standard deviations

Configurable parameters that the source documents do not fully specify:

- RSI period
- Stochastic lookback and smoothing
- ADX/DMI period
- Standard Bollinger lookback and deviation
- ATR period
- Volume-average lookback and heavy-volume multiplier
- Pivot-left and pivot-right windows
- Support/resistance tolerance
- Breakout buffer and follow-up window
- Gap significance threshold
- Divergence lookback and pivot matching tolerance
- Liquidity thresholds

Initial project defaults may be supplied in configuration, but must be labeled `PROJECT_DEFAULT`, backtested, and never represented as document-authored thresholds.

### 8. Apply the rule engines

Run in this order:

1. Index-level SMM, PAPA, and GUE context for all four indexes
2. Stock eligibility and data-quality gates for every constituent
3. Stock-level SMM direction and risk engine
4. Stock-level PAPA context, setup, and trigger engine
5. Stock-level GUE wave validation and target engine
6. FOME derivative overlay where applicable
7. Candidate tiering and ranking
8. Complete all-stock ledger and explanation generation

## Result States

Every rule returns one of:

- `PASS`: condition is satisfied from valid data
- `FAIL`: condition is conclusively not satisfied
- `WATCH`: close to a documented trigger, but not confirmed
- `MANUAL_REVIEW`: source concept is subjective or algorithmic confidence is insufficient
- `NO_DATA`: required data is unavailable or stale
- `NOT_APPLICABLE`: the rule does not apply to this security or mode

Never convert `MANUAL_REVIEW` or `NO_DATA` into `PASS`.

# SMM Rule Engine

## SMM 1 Trend classification

Classify the active timeframe:

- Uptrend: confirmed higher-high and higher-low structure.
- Downtrend: confirmed lower-high and lower-low structure.
- Sideways: neither directional structure is confirmed, or moving averages are flat/intermingled.

Supporting moving-average state:

- Bullish alignment: `EMA5 > EMA13 > EMA26 > EMA50`.
- Bearish alignment: `EMA5 < EMA13 < EMA26 < EMA50`.

Compare the stock's performance with its broad index and relevant sector index. Record outperformer (`Ghoda`) or underperformer (`Gadha`) as relative-strength evidence, not as an automatic entry.

## SMM 2 Tide-Wave-Ripple alignment

- Tide is the higher timeframe: normally weekly for a daily trading Wave.
- Wave is the decision timeframe: normally daily.
- Ripple is the lower timeframe used for entry timing when enabled.

Bullish directional gate:

- Tide MACD/trend-indicator slope is rising or has become flat after falling.
- Wave oscillator produces a confirmed bullish signal.

Bearish directional gate:

- Tide MACD/trend-indicator slope is falling or has become flat after rising.
- Wave oscillator produces a confirmed bearish signal.

If Tide and Wave disagree, return `WATCH` or `FAIL`; do not force a Bull or Bear hat.

## SMM 3 Candlestick evidence

Bullish candidates:

- Bullish candle
- Hammer at the bottom of a downtrend
- Bullish piercing
- Bullish engulfing
- Morning star
- Three white soldiers

Bearish candidates:

- Bearish candle
- Shooting star or inverted hammer at the top of an uptrend
- Bearish piercing
- Bearish engulfing
- Evening star
- Hanging man with bearish follow-up
- Three black crows

Neutral evidence:

- Doji
- Spinning top
- Harami
- High-wave candle

Context is mandatory. A reversal candle in the middle of a trend or range is not a reversal pass.

## SMM 4 Volume evidence

- Rising price with expanding volume supports a bullish trend.
- Falling price with expanding volume supports a bearish trend.
- Breakout or breakdown volume must exceed the configured average-volume threshold.
- The most significant heavy-volume candle may define support, resistance, stop, or invalidation.

Because the documents say “average of the last few days” without a fixed period, store the selected lookback and multiplier in the parameter version.

## SMM 5 EMA and indicators

- Positive lower-EMA crossover through a higher EMA is bullish.
- Negative lower-EMA crossover through a higher EMA is bearish.
- For morning/evening-star use, the decision checklist looks for EMA 5 crossing EMA 13 or 26 within the most recent three bars.
- MACD upward signal crossover is bullish; downward crossover is bearish.
- Oscillators are most reliable in trading ranges and may remain extreme during strong trends.
- Bullish divergence: price equal/lower low and oscillator higher low.
- Bearish divergence: price equal/higher high and oscillator lower high.

## SMM 6 Chart patterns

Bullish patterns:

- Inverted head and shoulders
- Double bottom
- Rounding bottom
- Cup and handle
- Bullish flag breakout
- Fake breakdown

Bearish patterns:

- Head and shoulders
- Double top
- Rounding top
- Bearish flag breakdown
- Fake breakout

If no valid pattern exists, the source recommends reviewing adjacent timeframes; absence of a pattern is not permission to fabricate one.

## SMM 7 Fibonacci continuation check

- Retracement at or below 50%: `HEALTHY` continuation evidence.
- Retracement at or above 61.8%: `WATCHFUL`.
- Between 50% and 61.8%: retain the numeric value and use configured neutral handling.

## SMM 8 Stop, target, and reward-risk

For bullish research:

- `reward = target - entry`
- `risk = entry - stop`

For bearish research:

- `reward = entry - target`
- `risk = stop - entry`

Require:

- A chart-derived stop below immediate support for bullish cases or above immediate resistance for bearish cases.
- A conservative target derived from a chart pattern or major support/resistance.
- `risk > 0` and `reward > 0`.
- Documented minimum reward/risk of 3. Use `reward / risk >= 3.0` as the conservative normalized gate unless the project explicitly adopts the stricter literal wording `> 3.0`.
- Adequate liquidity.
- No unresolved contradictory signal among required gates.

## SMM 9 Portfolio risk

- Maximum planned loss per position: less than or equal to 2% of total portfolio capital.
- Risk-based quantity: `floor((capital * risk_fraction) / abs(entry - stop))`.
- Also apply the allocation ceiling; use the smaller quantity from risk sizing, allocation sizing, and market/lot constraints.
- Portfolio guidance: 5 to 15 positions, normally 8% to 20% allocated to each.
- Do not add to a losing position.
- Use the stricter documented monthly loss stop of 8% until the 8% versus 10% source conflict is formally resolved.

## SMM 10 Exit evidence

Exit or reduce when a documented condition is met:

- Initial or trailing stop is breached
- Moving-average exit crossover
- Confirmed reversal pattern
- Price action invalidates the trade thesis
- Bullish position closes below EMA 5 on the Wave timeframe
- Bearish position closes above EMA 5 on the Wave timeframe
- Divergence or trend change materially opposes the position

Reaching a target does not automatically require a full exit if the documented trailing-stop method remains valid.

# PAPA Rule Engine

## PAPA 1 Price-action context

- Evaluate a reversal only at a meaningful trend extreme, support, resistance, or exhaustion area.
- Ignore Doji, hammer, shooting star, and engulfing patterns when they occur without relevant context.
- Longer rejection shadows carry more support/resistance evidence than shorter shadows.
- Three-candle formations receive greater evidence weight than equivalent single-candle formations.
- Volume must confirm important price action.

## PAPA 2 Canonical Bollinger states

Use these canonical names even when a source uses a transposed abbreviation:

- `UBBC`: upper Bollinger-band challenge with band expansion; bullish momentum.
- `LBBC`: lower Bollinger-band challenge with band expansion; bearish momentum.
- `UBBCF` or `BKT`: upper-band challenge failure with a flat/non-expanding upper band; bearish reversal evidence.
- `LBBCF` or `BKP`: lower-band challenge failure with a flat/non-expanding lower band; bullish reversal evidence.
- Price above the band median: bullish location.
- Price below the band median: bearish location.

Preserve the source abbreviation in the trace while using the canonical state internally.

## PAPA 3 Ungali momentum setup

Bullish Ungali conditions:

- Bullish candle and trend-line breakout (`TLBO`).
- Breakout volume above the configured average.
- `UBBC`.
- `+DI > -DI`.
- `ADX > 14`.
- `RSI > 60`.

Bearish Ungali conditions:

- Bearish trend-line breakdown (`TLBD`).
- Breakdown volume above the configured average.
- `LBBC`.
- `-DI > +DI`.
- `ADX > 14`.
- `RSI < 40`.

Continuation evidence may additionally require directional band slope, close beyond the prior close, and price on the correct side of EMA 5.

## PAPA 4 Advanced Dow reversal

Treat the source's four observations as increasing confirmation strength, not as a silently cumulative algorithm, until clarified.

Potential bullish reversal:

1. Price stops making lower lows.
2. Bullish close is above the prior bearish close.
3. Source also compares the bullish close with the prior bearish low; flag the redundancy for review.
4. Strong confirmation: bullish close above the prior bearish high and above daily EMA 5.

Potential bearish reversal:

1. Price stops making higher highs.
2. Bearish close is below the prior bullish close.
3. Source also compares the bearish close with the prior bullish high.
4. Strong confirmation: bearish close below the prior bullish low and below daily EMA 5.

Only level 4 may be used as a default deterministic confirmation. Lower levels are watch states unless configured otherwise.

## PAPA 5 Setup catalogue and triggers

### Double top

- Observation: neutral or bearish candle at prior resistance.
- Trigger: the bulls' weapon/support candle level is taken out.
- Support: bearish divergence, BKT, and heavy volume.
- Stop: high of the weapon candle.
- Target: documented double-top measurement or major support.

### Double bottom

- Observation: neutral or bullish candle at prior support.
- Trigger: the bears' weapon/resistance candle level is taken out.
- Support: bullish divergence, BKP, and heavy volume.
- Stop: low of the weapon candle.
- Target: documented double-bottom measurement or major resistance.

### Three white soldiers

- Wait for a pullback into the second soldier's high-low range.
- Trigger on renewed bullish price action.
- Stop below the first soldier unless a more conservative chart stop is configured.

### Three black crows

- Wait for a rally into the second crow's high-low range.
- Trigger on renewed bearish price action.
- Stop above the first crow unless a more conservative chart stop is configured.

### Bull counterattack

- Price opens below major support and re-enters above the breakdown level.
- Support: LBBCF/BKP and heavy volume.
- Stop: low of the counterattack candle.

### Bear counterattack

- Price opens above major resistance and re-enters below the breakout level.
- Support: UBBCF/BKT and heavy volume.
- Stop: high of the counterattack candle.

### Sandwich pattern

- Alternating bullish and bearish candles remain within a range.
- Trigger when a breakout candle closes above the relevant prior/range high or a breakdown candle closes below the relevant prior/range low.
- Stop beyond the trigger candle's opposite extreme.

### Genuine breakout or breakdown

- A shakeout occurs at the major level before the actual breakout/breakdown.
- A follow-up candle closes beyond the broken level.
- Ungali evidence is supportive.
- Stop beyond the breakout/breakdown candle.

### Fake breakout or breakdown

- Generally no preceding shakeout.
- Price returns inside the broken level with opposite-direction candles.
- A follow-up candle closes beyond the failed breakout/breakdown candle in the reversal direction.
- Divergence, BKT/BKP, and heavy volume are supportive.
- Stop beyond the failed breakout/breakdown candle.

### Gap setup

- Gap up: open above major resistance and sustain the gap.
- Gap down: open below major support and sustain the gap.
- Require follow-up before final confirmation.
- Ungali evidence is supportive.
- Stop beyond the gap trigger candle or gap boundary.

### Mother candle

- Mother candle contains the highs and lows of subsequent inside candles.
- At major support, breakout of the mother high is bullish reversal evidence; stop at the mother low.
- At major resistance, breakdown of the mother low is bearish reversal evidence; stop at the mother high.
- Inside a trend, breakout or breakdown may be continuation evidence.

### Other classified setups

- Rounding bottom: bullish reversal.
- Rounding top: bearish reversal.
- Accumulation at support: bullish reversal evidence.
- Distribution at resistance: bearish reversal evidence.
- Dark cloud cover: bearish reversal.
- Tweezers: bullish or bearish reversal depending on location.
- High-wave candle: indecision and possible reversal only with context and follow-up.

## PAPA 6 Heikin-Ashi

- `HA_close = (open + high + low + close) / 4`.
- `HA_open = (previous_HA_open + previous_HA_close) / 2`.
- `HA_high = max(high, HA_open, HA_close)`.
- `HA_low = min(low, HA_open, HA_close)`.
- Bullish decisive candle: no lower wick.
- Bearish decisive candle: no upper wick.
- Wicks on both sides: indecisive.
- A direct colour change at support/resistance without a neutral candle is strong evidence.
- Use HA for trailing-stop assistance, not as the only entry gate.

## PAPA 7 Extreme Bollinger warning

A candle beyond the 3-standard-deviation Bollinger Band indicates extreme excitement or panic and an elevated pullback probability. Use it to avoid impulsive entries or improve exits; do not automatically reverse solely because the band was exceeded.

# GUE Rule Engine

## GUE 1 Wave structure rules

For a standard impulse:

- Wave 2 must not retrace 100% or more of Wave 1.
- Wave 4 must not enter Wave 1 price territory.
- Wave 3 must not be the shortest of Waves 1, 3, and 5.

If any rule is violated, reject that impulse count. A diagonal is a separate structure and may allow Wave 4 to overlap Wave 1.

## GUE 2 Structure catalogue

- Impulse: five-wave motive structure.
- Extension: elongated Wave 1, 3, or 5.
- Truncation: Wave 5 fails to exceed Wave 3 while containing its required substructure.
- Ending diagonal: wedge-like motive structure at Wave 5 or C, commonly with 3-wave internal segments and Wave 1/4 overlap.
- Zigzag: A-B-C with 5-3-5 structure.
- Flat: A-B-C with 3-3-5 structure.
- Expanded flat: B exceeds the origin of A and C exceeds the end of A.
- Triangle: A-B-C-D-E, usually 3-3-3-3-3.
- Combination: multiple corrective structures connected by an X wave.

Wave counting must return a confidence value and alternative counts. Low-confidence counts are `MANUAL_REVIEW`, not hard passes.

## GUE 3 Wave personality evidence

- Wave 2: deep correction, weak volume/volatility, possible bullish divergence in an uptrend.
- Wave 3: broad, dynamic, strong volume, breakout/gap behavior, and often an extreme MACD reading.
- Wave 4: often sideways; MACD may return near zero; Bollinger bands may flatten.
- Wave 5: less breadth/dynamism than Wave 3 and often bearish divergence in an uptrend.
- Corrective waves: slower, overlapping, lower-volume action.

## GUE 4 Guidelines and projections

- Equality: two non-extended motive waves often approximate each other in price or time.
- Alternation: sharp Wave 2 suggests sideways Wave 4, and vice versa.
- Wave 4 often terminates near the prior fourth wave of one lesser degree.
- Channeling may project Wave 5 or Wave C.
- Corrective-wave volume generally contracts.
- A volume spike may accompany a terminal throw-over.

Fibonacci guideline candidates:

- Wave 2: 50% or 61.8% of Wave 1.
- Wave 3: 1.62, 2.62, or 4.25 times Wave 1.
- Wave 4: commonly 23.6% or 38.2% of Wave 3; sometimes 50% to 62%.
- Wave C in a zigzag: 1, 1.62, or 2.62 times Wave A.
- Expanded-flat B: approximately 1.15 or 1.25 times A.
- Expanded-flat C: approximately 1.62 or 2.62 times A.

These are target candidates, not Elliott rules. Rank confluence rather than asserting a single certain target.

## GUE 5 Third-wave setup

Bullish evidence from the dedicated checklist:

- Tide uptick.
- Tide `BBNC-DN`.
- Tide `P > 50` is desirable.
- Wave produces two higher lows.
- Wave trend-line breakout plus `BBC`.
- Bullish Ungali.
- Wave `P > 50`.
- Double-screen confirmation.
- Breakout volume above average is mandatory.
- Stop below the breakout/BBC candle.
- Target: Wave 3 equal to or 1.62 times Wave 1, as applicable.

Bearish evidence mirrors the above with Tide downtick, `BBNC-UP`, two lower highs, trend-line breakdown, bearish Ungali, and `P < 50`.

`BBNC`, `P`, and `BBC` are not fully defined in the supplied documents. Return `MANUAL_REVIEW` for those individual rules until the glossary is supplied; do not guess.

## GUE 6 Triangle breakout setup

- Intended to trade Wave 5 or Wave C after an A-B-C-D-E triangle.
- Align Tide MACD direction, double-screen direction, and Wave trend-line breakout/breakdown.
- Seek Ungali confirmation, MACD-histogram convergence/reversal near zero, and reverse divergence in the trade direction.
- Above-average breakout/breakdown volume is mandatory.
- Stop beyond the breakout/BBC candle.
- Target: triangle height projected from the breakout/breakdown, or approximately 62% of the post-triangle thrust when configured from the checklist.
- `AZ`, `BZ`, `BBNC`, and `BBC` remain unresolved source terms.

## GUE 7 Ending-diagonal setup

- Confirm the pattern is an ending diagonal at Wave 5 or C.
- Bullish reversal: diagonal breakout, bullish RSI/MACD divergence, favorable Tide, Ungali/double-screen/MACD confirmation, histogram convergence, and trend-line breakout.
- Bearish reversal: mirror conditions on diagonal breakdown.
- Above-average breakout/breakdown volume is mandatory.
- Stop beyond the breakout/breakdown or BBC candle.
- Target the beginning of the diagonal/wedge and compare with the prior lower-degree fourth-wave area.

## GUE 8 Other high-probability setups

- End of Wave 2 for Wave 3.
- End of Wave 4 for Wave 5, supported by MACD zero-line reversal or reverse divergence.
- End of Wave C for resumption of the higher-degree trend.
- End of Wave 5 for a corrective countertrend move, only after five-wave completion and divergence.
- Head-and-shoulders with A-B-C context and neckline confirmation.
- Failed head-and-shoulders when the higher-timeframe Tide opposes the apparent reversal.
- GMMA compression followed by expansion as corrective-to-impulse evidence.

# FOME Rule Engine

Apply FOME after the directional/range view is established. `NOT_APPLICABLE` is valid for securities without current derivative eligibility and must not reduce their equity-screen score.

## FOME 1 Contract calculations

- Call intrinsic value: `max(spot - strike, 0)`.
- Put intrinsic value: `max(strike - spot, 0)`.
- Time value: `premium - intrinsic_value`.
- Call expiry break-even: `strike + premium`.
- Put expiry break-even: `strike - premium`.
- Delta estimate: `change_in_premium / change_in_spot`.
- Futures break-even before costs: entry futures price.

Use current contract specifications. Never copy lot sizes, margins, or expiries from examples in the training material.

## FOME 2 Futures OI interpretation

- Price up and OI up: long buildup, bullish.
- Price down and OI up: short buildup, bearish.
- Price up and OI down: short covering, bullish.
- Price down and OI down: long covering, bearish.

## FOME 3 Option OI interpretation

For calls:

- Call price up and call OI up: bullish/watchful.
- Call price up and call OI down: strong bullish.
- Call price down and call OI down: bearish.
- Call price down and call OI up: strong bearish.

For puts:

- Put price up and put OI up: bearish/watchful.
- Put price up and put OI down: strong bearish.
- Put price down and put OI down: bullish.
- Put price down and put OI up: strong bullish.

Highest relevant put OI is support evidence; highest relevant call OI is resistance evidence. OI is supportive evidence, not a standalone forecast.

## FOME 4 Market-state to strategy mapping

Strong bullish trend:

- Long futures
- Buy call
- Bullish call ratio spread
- Defined-risk bullish spread when cost/risk is preferable

Strong bearish trend:

- Short futures
- Buy put
- Bearish put ratio spread
- Defined-risk bearish spread

Moderately bullish or sideways near support:

- Covered call
- Bull call spread
- Bull put spread
- Long collar when protection is required

Moderately bearish or sideways near resistance:

- Covered put
- Bear put spread
- Bear call spread
- Short collar when protection is required

Restricted range:

- Protected short straddle or strangle
- Short iron butterfly
- Short iron condor

Expected large move in either direction:

- Long straddle
- Long strangle
- Long iron butterfly or condor when the expected move is limited to a defined range

Target likely after current expiry:

- Calendar spread using aligned strikes and validated liquidity

Do not recommend naked option selling as a default research output. Always show defined-risk alternatives, worst-case risk, margin, liquidity, and expiry sensitivity.

## FOME 5 Trend qualification

Bullish derivative view:

- Rising Tide MACD.
- Trend-line breakout.
- Bullish Ungali.
- RSI above 60.
- Evidence of a bullish impulse.
- Supportive put/call OI and futures long buildup.

Bearish derivative view mirrors these conditions with falling Tide MACD, trend-line breakdown, RSI below 40, bearish impulse evidence, and futures short buildup.

The guide's bearish row contains `NP`, which conflicts with its own classification of naked-put selling as bullish. Mark this source rule `CONFLICT` and do not automate that leg until corrected.

## FOME 6 Sideways and volatility rules

- Sideways evidence: flat Tide MACD, flat/falling Wave ADX, ADX below approximately 12 in the guide, and flat Bollinger bands or BKT/BKP conditions.
- Avoid naked option buying in a stable range.
- High time value or volatility favors credit structures when risk is defined.
- Moderate or low time value favors debit structures when the directional setup is valid.
- Momentum mode: ADX rising from approximately 15 or above, price in the correct Bollinger half, and bands moving in the trade direction.
- Swing/range mode: ADX below 20 or falling, entries near established support/resistance.

## FOME 7 Spread and ROI comparisons

- Premium difference less than half the strike spread: evaluate debit spread.
- Premium difference greater than half the strike spread: evaluate credit spread.
- Debit ROI: maximum possible return divided by premium debit plus any margin.
- Credit ROI: premium credit divided by margin deployed; also show maximum loss.
- Futures ROI: target gain divided by margin deployed; also show loss at invalidation.
- Naked option-buying allocation should normally remain within 5% to 8% of account value while planned loss remains within the 2% portfolio-risk rule.

Always calculate payoff at multiple underlying prices, break-evens, maximum profit, maximum loss, net debit/credit, margin, and estimated transaction costs.

# Candidate Gates, Tiers, and Ranking

Apply gates and tiers separately to every stock. Index-level outcomes are stored in an index report and as stock context fields; they are not a replacement for a stock's own gate results.

## Hard gates

A candidate cannot be Tier A or B unless all applicable hard gates pass:

- Current universe membership verified
- Data quality and freshness pass
- Minimum liquidity pass
- SMM Tide-Wave direction is aligned
- A PAPA setup and trigger are confirmed
- Valid stop and conservative target exist
- Reward/risk meets the normalized 3.0 minimum
- Planned position risk does not exceed 2% of portfolio capital
- No unresolved required-rule contradiction

FOME is a derivative overlay and is not a hard gate for an equity-only candidate.

## Tiers

- **Tier A:** all hard gates pass, GUE count/setup has acceptable confidence, and no mandatory manual review remains.
- **Tier B:** SMM, PAPA, data, and risk gates pass; GUE is uncertain or requires manual validation.
- **Watch:** directional context exists, but confirmation, volume, reward/risk, or follow-up is pending.
- **Rejected:** at least one hard rule conclusively fails.
- **Unavailable:** required data is stale, invalid, or absent.

## Ranking

Rank only within the same direction and tier. Keep the scoring model configurable and versioned.

Suggested initial 100-point research score:

- SMM trend and timeframe alignment: 25
- PAPA setup quality and confirmation: 30
- Volume, momentum, and divergence confluence: 15
- GUE wave confidence and target confluence: 15
- Reward/risk and stop quality above the hard minimum: 10
- Data quality and liquidity strength: 5

Do not award FOME points to non-derivative stocks. For derivative-eligible stocks, provide a separate `derivative_fit_score` instead of changing the core stock score.

# Output Contract

## Run summary

Return:

- Run ID
- Rule and parameter versions
- Data mode and timestamps
- Latest completed session/bar
- Provider names
- Universe count by index
- Deduplicated stock count
- Valid, partial, stale, invalid, and missing-data counts
- Tier A, Tier B, Watch, Rejected, and Unavailable counts
- Coverage reconciliation proving that every deduplicated constituent has exactly one terminal result

## Index analysis table

Return one row for each of NIFTY 50, NIFTY Bank, NIFTY 100, and NIFTY 500 containing:

- Index name and symbol
- Latest value and timestamp
- SMM Tide, Wave, and Ripple states
- EMA/MACD/RSI/ADX/Bollinger state
- PAPA setup and confirmation status
- GUE impulse/corrective classification and confidence
- Major support, resistance, and market-regime conclusion
- Breadth measures when available

## Complete all-stock ledger

Return and persist one row for every unique constituent in `stock_universe`, including stocks that are rejected or unavailable. Include:

- Symbol, company, stable instrument ID, and all index memberships
- Latest price and timestamp
- Data-quality state
- Bullish and bearish rule outcomes
- SMM, PAPA, GUE, risk, and FOME states
- Tier or rejection/unavailable status
- Primary pass, failure, Watch, or manual-review reason
- Full rule-trace reference

Reconcile:

`unique_stock_count = Tier_A + Tier_B + Watch + Rejected + Manual_Review + Unavailable`

If the equality fails or a security has more than one primary result, the run is incomplete and must not be published as complete.

## Ranked candidate table

Include at least:

- Rank
- Symbol and company
- Index memberships
- Direction
- Tier and score
- Latest price and timestamp
- Tide, Wave, and Ripple states
- SMM result
- PAPA setup and trigger
- GUE primary and alternative wave counts with confidence
- FOME applicability and strategy comparison
- Entry trigger or confirmation level
- Stop/invalidation
- Conservative and extended targets
- Reward/risk
- Risk-based quantity and allocation-constrained quantity
- Liquidity and data-quality state
- Primary supporting evidence
- Primary risk or failed/uncertain evidence

The ranked table contains qualifying or near-qualifying stocks only. It must link back to the corresponding row in the complete all-stock ledger.

## Rule trace

For each evaluated rule, persist:

- `rule_id`
- framework and source wording
- normalized rule
- timeframe
- observed value or structure
- threshold or comparison
- result state
- confidence when applicable
- market-data source and timestamp
- document provenance
- explanation

## Near misses

Report Watch candidates with the exact missing confirmation, such as:

- Follow-up close not yet complete
- Volume below required average
- Reward/risk below 3
- Tide and Wave disagree
- Price approaching but not breaking the mother candle
- GUE count ambiguous

# Backtesting Requirements

- Use point-in-time index membership when available; otherwise disclose survivorship bias.
- Generate close-confirmed signals using only information known at that close.
- Execute at the next realistically tradable price unless testing a documented intraday trigger.
- Do not use future-confirmed pivots, final swing labels, or completed Elliott counts at an earlier timestamp.
- Adjust equities for corporate actions while preserving unadjusted prices where contract matching requires them.
- Include brokerage, exchange charges, taxes, bid-ask spread, slippage, option liquidity, and contract rollover.
- Prevent overlapping positions from exceeding portfolio and per-position risk limits.
- Separate development, validation, and out-of-sample periods.
- Use walk-forward or rolling evaluation for tuned parameters.
- Report candidate count, trade count, win rate, average win/loss, expectancy, profit factor, drawdown, exposure, turnover, and regime performance.
- Compare against simple benchmarks and ablations: SMM only, SMM plus PAPA, plus GUE, and derivative overlay.
- Never optimize on the same period used for the final performance claim.

# Known Source Issues

Keep these unresolved until the user supplies definitions or approves a normalization:

- `AMAR`, `AKBAR`, `ANTHONY`, and `CVECp`
- `BBNC-DN`, `BBNC-UP`, `BBC`, `AZ`, `BZ`, and `P > 50/P < 50`
- The PAPA intermediate advanced-Dow comparisons
- `UBBCF/UBBFC` and `LBBCF/LBBFC` spelling variants; use canonical `UBBCF` and `LBBCF`
- SMM 8% versus FOME 10% monthly-loss limit; use 8% provisionally
- FOME bearish-row `NP` conflict
- Subjective words including significant, reasonable, heavy, huge, major, shakeout, weapon, operator-driven, and clear pattern

When any unresolved item is required for a result, emit `MANUAL_REVIEW` or `CONFLICT`; do not infer the favorable answer.

# Source Files

The primary project sources are the unique versions of:

- `Secrets Of Market Millionaires_Dec22_v2 (1).pdf`
- `SMM Concepts Part 1 (1) (1).pdf`
- `SMM Concepts Part 2_Nov21 (1).pdf`
- `SMM Concepts Part 3 (1).pdf`
- `SMM Concepts Part 4 (1).pdf`
- `SMM DECISION SHEET (1).pdf`
- `ASTA - SMM Decision Sheet 1 (1).xlsx`
- `Pay Attention To Price Action.pdf`
- `PAPA Concept 1 (2).pdf`
- `PAPA Concept 2_v3.pdf`
- `PAPA Concept 3 (1).pdf`
- `PAPA DECISION SHEET_SEP22.pdf`
- `PAPA Decision Sheet - FINAL1 (1).xlsx`
- `PAPA SEMINOR.docx`
- `Get Ultimate Edge (1) (1).pdf`
- `GUE Concepts - Part 1 (2) (1).pdf`
- `GUE Concepts - Part 2 (2) (1).pdf`
- `GUE Concepts - Part 3 (2) (1).pdf`
- `3RD WAVE SETUP (1) (1).pdf`
- `ENDING DIAGONAL SETUP (1) (1).pdf`
- `TRIANGLE BREAKOUT SETUP (1) (1).pdf`
- `GUE Homework Sheet (1) (2) (1).xlsx`
- `Futures & Options Made Easy_V6 (1).pdf`
- `FOME Concept Part 1 - Futures-1 (1).pdf`
- `FOME Concept Part 2 - Options (1) (1).pdf`
- `FOME GUIDE SHEET-V3 (1).pdf`
- `FOME Decision Sheet (3) (1).xlsx`

Treat same-hash numbered copies, HTML download wrappers, and ZIP containers as duplicates rather than independent strategy sources.

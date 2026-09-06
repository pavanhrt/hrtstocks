# GUE — Get Ultimate Edge

Companion executable specification: [gue.yaml](gue.yaml)

## Purpose

Classify Elliott-wave structure, reject invalid counts, identify high-probability setups, estimate targets, and expose confidence plus alternative counts.

## Elliott rules

For a standard impulse:

1. Wave 2 must not retrace 100% or more of Wave 1.
2. Wave 4 must not enter Wave 1 price territory.
3. Wave 3 must not be the shortest of Waves 1, 3, and 5.

A violation rejects that impulse count. Diagonals are separate structures and may allow Wave 1/4 overlap.

## Structures

- Impulse: five-wave motive structure.
- Extension: elongated Wave 1, 3, or 5.
- Truncation: Wave 5 fails to exceed Wave 3 while retaining required substructure.
- Ending diagonal: wedge at Wave 5 or C, commonly three-wave segments and Wave 1/4 overlap.
- Zigzag: A-B-C, 5-3-5.
- Flat: A-B-C, 3-3-5.
- Expanded flat: B exceeds A origin and C exceeds A end.
- Triangle: A-B-C-D-E, normally 3-3-3-3-3.
- Combination: corrective structures joined by an X wave.

Return a primary count, alternative counts, confidence, evidence, and invalidation. Low confidence produces `MANUAL_REVIEW`.

## Personality evidence

- Wave 2: deep correction, weaker volume/volatility, possible bullish divergence.
- Wave 3: broad/dynamic, strong volume, breakout/gap behavior, often extreme MACD.
- Wave 4: often sideways, MACD near zero, flattening bands.
- Wave 5: less broad/dynamic than Wave 3, often divergence.
- Corrections: slower, overlapping, lower-volume action.

## Guidelines and targets

Guidelines support confidence but are not Elliott rules: equality, alternation, prior fourth-wave termination, channeling, contracting corrective volume, and possible terminal throw-over volume.

Candidate Fibonacci projections:

- Wave 2: 50% or 61.8% of Wave 1.
- Wave 3: 1.62, 2.62, or 4.25 times Wave 1.
- Wave 4: commonly 23.6% or 38.2% of Wave 3; sometimes 50%–62%.
- Zigzag C: 1, 1.62, or 2.62 times A.
- Expanded-flat B: approximately 1.15 or 1.25 times A.
- Expanded-flat C: approximately 1.62 or 2.62 times A.

Rank target confluence; do not assert one certain target.

## Third-wave setup

Bullish evidence includes Tide uptick, two Wave higher lows, trend-line breakout, bullish Ungali, double-screen confirmation, and mandatory above-average breakout volume. Stop below breakout/BBC candle; target Wave 3 equality or 1.62× Wave 1 as applicable. Bearish rules mirror this.

`BBNC-DN`, `BBNC-UP`, `BBC`, and `P > 50/P < 50` remain unresolved. Their individual results require manual review.

## Triangle breakout

Trade a possible Wave 5 or C after an A-B-C-D-E triangle. Align Tide MACD, double-screen, and Wave trend-line break; seek Ungali, histogram reversal near zero, reverse divergence, and mandatory above-average break volume. Stop beyond breakout/BBC candle. Candidate target is triangle height or configured 62% post-triangle thrust. `AZ`, `BZ`, `BBNC`, and `BBC` remain unresolved.

## Ending diagonal

Confirm position at Wave 5 or C. Seek diagonal break, RSI/MACD divergence, favorable Tide, Ungali/double-screen/MACD evidence, histogram convergence, and mandatory above-average volume. Stop beyond the break/BBC candle. Target the diagonal origin/wedge beginning and compare the prior lower-degree fourth-wave area.

## Other setups

- End Wave 2 for Wave 3
- End Wave 4 for Wave 5
- End Wave C for higher-degree trend resumption
- End Wave 5 for countertrend correction only after completion and divergence
- Head-and-shoulders with A-B-C context and neckline confirmation
- Failed head-and-shoulders when higher-timeframe Tide opposes reversal
- GMMA compression followed by expansion

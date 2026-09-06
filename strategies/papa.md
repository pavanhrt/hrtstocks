# PAPA — Pay Attention to Price Action

Companion executable specification: [papa.yaml](papa.yaml)

## Purpose

Require meaningful price location, a recognizable setup, confirmation/follow-up, volume support, and chart-based invalidation.

## Context

- Consider reversal evidence only at a meaningful trend extreme, support, resistance, or exhaustion area.
- Ignore isolated doji, hammer, shooting-star, or engulfing labels without location and follow-up.
- Longer rejection shadows have more evidence weight.
- Three-candle structures have greater weight than equivalent single-candle structures.
- Important price action requires volume confirmation.

## Canonical Bollinger states

- `UBBC`: upper-band challenge with expansion; bullish momentum.
- `LBBC`: lower-band challenge with expansion; bearish momentum.
- `UBBCF` / `BKT`: upper challenge failure with flat/non-expanding upper band; bearish reversal evidence.
- `LBBCF` / `BKP`: lower challenge failure with flat/non-expanding lower band; bullish reversal evidence.
- Above band median is bullish location; below is bearish location.

Preserve source spelling while using canonical internal names.

## Ungali momentum

Bullish conditions: bullish candle, trend-line breakout, above-average volume, UBBC, `+DI > -DI`, `ADX > 14`, and `RSI > 60`.

Bearish conditions: bearish candle, trend-line breakdown, above-average volume, LBBC, `-DI > +DI`, `ADX > 14`, and `RSI < 40`.

Optional continuation evidence includes directional band slope, close beyond prior close, and correct side of EMA 5.

## Advanced Dow reversal

Treat the four source observations as increasing confirmation until clarified. Default deterministic confirmation is level 4 only:

- Bullish: price stops making lower lows; final confirmation is a bullish close above the prior bearish high and daily EMA 5.
- Bearish: price stops making higher highs; final confirmation is a bearish close below the prior bullish low and daily EMA 5.

Intermediate source comparisons remain `UNRESOLVED` and therefore Watch/manual-review evidence.

## Setups and triggers

- **Double top:** observe at prior resistance; trigger when the bulls' support/weapon level breaks; stop at weapon-candle high; target measured pattern or major support.
- **Double bottom:** observe at prior support; trigger when the bears' resistance/weapon level breaks; stop at weapon-candle low; target measured pattern or major resistance.
- **Three white soldiers:** wait for pullback into the second soldier range and renewed bullish action; default stop below first soldier.
- **Three black crows:** wait for rally into the second crow range and renewed bearish action; default stop above first crow.
- **Bull counterattack:** open below major support then reclaim it; seek BKP and heavy volume; stop at candle low.
- **Bear counterattack:** open above major resistance then reject below it; seek BKT and heavy volume; stop at candle high.
- **Sandwich:** alternating candles remain within a range; trigger on a closing range break; stop beyond trigger candle's opposite extreme.
- **Genuine breakout/breakdown:** shakeout before the break, then follow-up close beyond level; Ungali supports; stop beyond break candle.
- **Fake breakout/breakdown:** no normal shakeout, return inside level, then opposite follow-up beyond failed-break candle; divergence/BKT/BKP/volume support; stop beyond failed-break candle.
- **Gap:** open beyond major level, sustain, and confirm on follow-up; stop beyond trigger candle or gap boundary.
- **Mother candle:** contains later inside candles; at support, mother-high breakout is bullish with stop at mother low; at resistance, mother-low breakdown is bearish with stop at mother high.
- Other classified evidence: rounding tops/bottoms, accumulation/distribution, dark-cloud cover, tweezers, and high-wave candles.

## Heikin-Ashi

- `HA_close = (open + high + low + close) / 4`
- `HA_open = (previous_HA_open + previous_HA_close) / 2`
- `HA_high = max(high, HA_open, HA_close)`
- `HA_low = min(low, HA_open, HA_close)`
- No lower wick supports decisive bullish action; no upper wick supports decisive bearish action; both wicks signal indecision.
- Use HA for trailing-stop assistance, never as the sole entry gate.

## Extreme Bollinger warning

A candle beyond a 3-standard-deviation Bollinger Band indicates extreme excitement/panic and elevated pullback probability. It is entry/exit caution, not an automatic reversal.

# SMM — Secrets of Market Millionaires

Companion executable specification: [smm.yaml](smm.yaml)

## Purpose

Determine direction through trend and Tide/Wave/Ripple alignment, confirm with technical evidence, and enforce risk, reward, sizing, and exit discipline.

## Trend and relative strength

- Uptrend: confirmed higher highs and higher lows.
- Downtrend: confirmed lower highs and lower lows.
- Sideways: neither structure is confirmed or moving averages are flat/intermingled.
- Bullish EMA alignment: `EMA5 > EMA13 > EMA26 > EMA50`.
- Bearish EMA alignment: `EMA5 < EMA13 < EMA26 < EMA50`.
- Compare the stock with broad and sector indexes. `Ghoda` means outperformer and `Gadha` means underperformer; this is evidence, not an automatic entry.

## Tide, Wave, and Ripple

- Tide: higher timeframe, normally weekly for a daily Wave.
- Wave: decision timeframe, normally daily.
- Ripple: optional lower timeframe for entry timing.
- Bullish gate: Tide MACD/trend slope rises or flattens after falling, and the Wave oscillator confirms bullishly.
- Bearish gate: Tide MACD/trend slope falls or flattens after rising, and the Wave oscillator confirms bearishly.
- Disagreement produces `WATCH` or `FAIL`, never a forced direction.

## Evidence

Bullish candles include hammer at a downtrend bottom, bullish piercing/engulfing, morning star, and three white soldiers. Bearish candles include shooting star/inverted hammer at an uptrend top, bearish piercing/engulfing, evening star, hanging man with follow-up, and three black crows. Doji, spinning top, harami, and high-wave candles are neutral until context and follow-up resolve them.

Volume supports direction when price movement expands with volume. Breakouts require volume above the versioned average-volume threshold. The source does not fix “last few days,” so lookback and multiplier remain `PROJECT_DEFAULT` parameters.

Indicator evidence:

- Lower EMA crossing upward through a higher EMA is bullish; downward is bearish.
- Morning/evening-star checklist: EMA 5 crosses EMA 13 or 26 within the latest three bars.
- MACD signal crossover supports the corresponding direction.
- Bullish divergence: price equal/lower low and oscillator higher low.
- Bearish divergence: price equal/higher high and oscillator lower high.

## Pattern catalogue

- Bullish: inverted head-and-shoulders, double bottom, rounding bottom, cup and handle, bullish flag breakout, fake breakdown.
- Bearish: head-and-shoulders, double top, rounding top, bearish flag breakdown, fake breakout.
- Absence of a valid pattern may trigger adjacent-timeframe review, not pattern fabrication.

## Fibonacci continuation

- Retracement `<= 50%`: `HEALTHY` continuation evidence.
- Retracement `>= 61.8%`: `WATCHFUL`.
- Between those values: retain the number and use versioned neutral handling.

## Risk, target, and sizing

Bullish: `reward = target - entry`; `risk = entry - stop`.

Bearish: `reward = entry - target`; `risk = stop - entry`.

Qualification requires positive risk and reward, chart-derived invalidation, conservative chart target, adequate liquidity, no unresolved required contradiction, and normalized `reward / risk >= 3.0`.

- Maximum planned loss per position: 2% of capital.
- Risk quantity: `floor((capital × risk_fraction) / abs(entry - stop))`.
- Final quantity is the minimum of risk, allocation, liquidity, and lot constraints.
- Portfolio guidance: 5–15 positions, normally 8%–20% allocation each.
- Do not add to losing positions.
- Provisional monthly loss stop: 8% until the source conflict is resolved.

## Exit evidence

Exit or reduce upon stop breach, exit EMA crossover, confirmed reversal, thesis invalidation, bullish close below Wave EMA 5, bearish close above Wave EMA 5, or material opposing divergence/trend change. A target may be managed with a documented trailing stop rather than forcing a full exit.

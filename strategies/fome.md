# FOME — Futures and Options Made Easy

Companion executable specification: [fome.yaml](fome.yaml)

`FOME` is canonical. Accept `FOAM` only as a user alias.

## Purpose and scope

Apply FOME after an equity/index directional or range view exists. For stocks without current derivatives, return `NOT_APPLICABLE` without reducing the equity score.

## Contract calculations

- Call intrinsic: `max(spot - strike, 0)`
- Put intrinsic: `max(strike - spot, 0)`
- Time value: `premium - intrinsic_value`
- Call expiry break-even: `strike + premium`
- Put expiry break-even: `strike - premium`
- Delta estimate: `change_in_premium / change_in_spot`
- Futures break-even before costs: entry futures price

Use current contract specifications, expiry, lot size, margin, quotes, and timestamps—not training examples.

## Open-interest interpretation

Futures:

- Price up/OI up: long buildup, bullish.
- Price down/OI up: short buildup, bearish.
- Price up/OI down: short covering, bullish.
- Price down/OI down: long covering, bearish.

Calls:

- Premium up/OI up: bullish/watchful.
- Premium up/OI down: strong bullish.
- Premium down/OI down: bearish.
- Premium down/OI up: strong bearish.

Puts:

- Premium up/OI up: bearish/watchful.
- Premium up/OI down: strong bearish.
- Premium down/OI down: bullish.
- Premium down/OI up: strong bullish.

Highest relevant put OI is support evidence and highest relevant call OI is resistance evidence. OI is not a standalone forecast.

## Strategy mapping

- Strong bullish: long futures, buy call, bullish call ratio spread, or defined-risk bullish spread.
- Strong bearish: short futures, buy put, bearish put ratio spread, or defined-risk bearish spread.
- Moderately bullish/near support: covered call, bull call spread, bull put spread, protected long collar.
- Moderately bearish/near resistance: covered put, bear put spread, bear call spread, protected short collar.
- Restricted range: protected short straddle/strangle, short iron butterfly, or short iron condor.
- Large move either way: long straddle/strangle or suitable defined-risk iron structure.
- Target beyond current expiry: aligned-strike calendar spread with validated liquidity.

Do not default to naked option selling. Always display defined-risk alternatives, maximum loss, margin, liquidity, and expiry sensitivity.

## Trend qualification

Bullish view: rising Tide MACD, trend-line breakout, bullish Ungali, RSI above 60, bullish impulse evidence, supportive option OI, and futures long buildup. Bearish view mirrors with falling Tide MACD, breakdown, RSI below 40, bearish impulse, and futures short buildup.

The bearish guide row containing `NP` conflicts with its naked-put classification. Keep it `CONFLICT` and do not automate that leg.

## Range and volatility

- Sideways evidence: flat Tide MACD, flat/falling Wave ADX, guide ADX approximately below 12, and flat bands or BKT/BKP.
- Avoid naked option buying in a stable range.
- High time value/volatility may favor defined-risk credit structures.
- Moderate/low time value may favor debit structures when direction is valid.
- Momentum mode: ADX rising from approximately 15+, correct Bollinger half, bands moving with direction.
- Swing/range mode: ADX below 20 or falling, entries near support/resistance.

## Payoff and ROI

- Premium difference below half the strike width: evaluate debit spread.
- Premium difference above half the strike width: evaluate credit spread.
- Debit ROI: max possible return divided by premium debit plus margin.
- Credit ROI: credit divided by deployed margin; also show max loss.
- Futures ROI: target gain divided by margin; also show invalidation loss.
- Naked option-buying allocation guideline: normally 5%–8% of capital, while planned loss remains within the 2% portfolio-risk ceiling.

Calculate multiple expiry payoff points, break-evens, max profit, max loss, net debit/credit, margin, liquidity, expiry sensitivity, and estimated costs.

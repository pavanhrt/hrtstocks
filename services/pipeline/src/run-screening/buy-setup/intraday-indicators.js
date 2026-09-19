// 15-minute technical-indicator evidence for the /buy-setup-analysis page.
// Every calculation reuses features/indicators.js verbatim (RSI, slow
// Stochastic, Bollinger Bands, +DI/-DI/ADX, MACD/MACD histogram) -- no new
// indicator formula is introduced here, only composition into one evidence
// object plus a simple band-position read.
//
// Bollinger "status" here is a plain position read (above the upper band /
// within the bands / below the lower band) against the documented
// standard_bollinger_deviation (2.0, config/parameters.yaml) -- it is
// deliberately NOT strategies/papa.md's canonical UBBC/LBBC/UBBCF/LBBCF
// classification, which additionally requires band-expansion and momentum
// context this module does not attempt to assemble. Presenting this as a
// PAPA Bollinger state would overclaim; it is labeled "positionOnly" so the
// UI/data layer can show it as a plain reading, not a named PAPA condition.

import { rsiWithPrevious, stochastic, bollingerBands, adx, macd, macdHistogramSeries } from "../features/indicators.js";

/**
 * @param {import("../providers/types.js").Bar[]} bars oldest-first, 15-minute, complete candles only
 * @param {{
 *   rsiPeriod:number, stochasticLookback:number, stochasticSmoothing:number,
 *   bollingerLookback:number, bollingerDeviation:number,
 *   adxDmiPeriod:number, macdFast:number, macdSlow:number, macdSignal:number,
 * }} params
 */
export function computeIntradayIndicators(bars, params) {
  if (!bars || bars.length === 0) {
    return {
      evidenceCandleTs: null,
      rsi: null,
      rsiPrevious: null,
      stochasticK: null,
      stochasticD: null,
      stochasticKPrevious: null,
      stochasticDPrevious: null,
      bollingerUpper: null,
      bollingerMiddle: null,
      bollingerLower: null,
      bollingerStatus: "NO_DATA",
      plusDi: null,
      minusDi: null,
      adx: null,
      macdLine: null,
      macdSignal: null,
      macdHistogram: null,
      macdHistogramPrevious: null,
    };
  }

  const closes = bars.map((b) => b.close);
  const highs = bars.map((b) => b.high);
  const lows = bars.map((b) => b.low);
  const evidenceCandleTs = bars[bars.length - 1].ts ?? bars[bars.length - 1].date;

  const { value: rsiValue, previous: rsiPrevious } = rsiWithPrevious(closes, params.rsiPeriod);
  const { k, d, kPrevious, dPrevious } = stochastic(
    highs,
    lows,
    closes,
    params.stochasticLookback,
    params.stochasticSmoothing,
    params.stochasticSmoothing
  );
  const bands = bollingerBands(closes, params.bollingerLookback, params.bollingerDeviation);
  const lastClose = closes[closes.length - 1];
  let bollingerStatus = "NO_DATA";
  if (bands.upper != null && bands.lower != null) {
    bollingerStatus = lastClose > bands.upper ? "above_upper" : lastClose < bands.lower ? "below_lower" : "within_bands";
  }
  const { plusDI, minusDI, adx: adxValue } = adx(highs, lows, closes, params.adxDmiPeriod);
  const macdResult = macd(closes, params.macdFast, params.macdSlow, params.macdSignal);
  const histogramSeries = macdHistogramSeries(closes, params.macdFast, params.macdSlow, params.macdSignal);
  const macdHistogramPrevious = histogramSeries[histogramSeries.length - 2] ?? null;

  return {
    evidenceCandleTs,
    rsi: rsiValue,
    rsiPrevious,
    stochasticK: k,
    stochasticD: d,
    stochasticKPrevious: kPrevious,
    stochasticDPrevious: dPrevious,
    bollingerUpper: bands.upper,
    bollingerMiddle: bands.middle,
    bollingerLower: bands.lower,
    bollingerStatus,
    plusDi: plusDI,
    minusDi: minusDI,
    adx: adxValue,
    macdLine: macdResult.macd,
    macdSignal: macdResult.signal,
    macdHistogram: macdResult.histogram,
    macdHistogramPrevious,
  };
}

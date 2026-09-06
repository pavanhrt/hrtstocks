// Deterministic technical-indicator calculations over OHLCV bar arrays.
// Bars are oldest-first: [{ date, open, high, low, close, volume }, ...].
//
// Only indicators with a resolved parameter value in config/parameters.yaml
// are implemented here (EMA, MACD, Bollinger, Fibonacci). RSI/Stochastic/ADX/
// ATR/pivot-window parameters are still `null` under
// project_defaults_requiring_backtest, and per the project's null_policy
// ("unresolved parameters must not be assumed documented") the rule engine
// must not silently pick a period for them -- see evaluate.js, which routes
// any rule needing one of those to MANUAL_REVIEW instead of calling a
// function here.

/** Simple moving average of the last `period` closes, or null if not enough bars. */
export function sma(closes, period) {
  if (closes.length < period) return null;
  let sum = 0;
  for (let i = closes.length - period; i < closes.length; i++) sum += closes[i];
  return sum / period;
}

/**
 * Full EMA series (same length as input, leading `period - 1` entries null),
 * seeded with a SMA of the first `period` values per the standard convention.
 */
export function emaSeries(closes, period) {
  const out = new Array(closes.length).fill(null);
  if (closes.length < period) return out;
  const k = 2 / (period + 1);
  let prev = sma(closes.slice(0, period), period);
  out[period - 1] = prev;
  for (let i = period; i < closes.length; i++) {
    prev = closes[i] * k + prev * (1 - k);
    out[i] = prev;
  }
  return out;
}

/** Latest EMA value, or null if there isn't a full `period` of history yet. */
export function ema(closes, period) {
  const series = emaSeries(closes, period);
  return series[series.length - 1];
}

/**
 * MACD line, signal line, and histogram (latest values only).
 * fast/slow/signal periods come from config/parameters.yaml (12/26/9, documented).
 */
export function macd(closes, fastPeriod, slowPeriod, signalPeriod) {
  if (closes.length < slowPeriod + signalPeriod) {
    return { macd: null, signal: null, histogram: null };
  }
  const fastSeries = emaSeries(closes, fastPeriod);
  const slowSeries = emaSeries(closes, slowPeriod);
  const macdSeries = closes.map((_, i) =>
    fastSeries[i] === null || slowSeries[i] === null ? null : fastSeries[i] - slowSeries[i]
  );
  const validMacd = macdSeries.filter((v) => v !== null);
  if (validMacd.length < signalPeriod) return { macd: null, signal: null, histogram: null };

  const signalSeries = emaSeries(validMacd, signalPeriod);
  const macdLatest = validMacd[validMacd.length - 1];
  const signalLatest = signalSeries[signalSeries.length - 1];
  return {
    macd: macdLatest,
    signal: signalLatest,
    histogram: signalLatest === null ? null : macdLatest - signalLatest,
  };
}

/** MACD line slope classification used by SMM's tide_macd_slope / tide_macd_transition inputs. */
export function macdSlope(closes, fastPeriod, slowPeriod, signalPeriod, lookback = 3) {
  const fastSeries = emaSeries(closes, fastPeriod);
  const slowSeries = emaSeries(closes, slowPeriod);
  const macdSeries = closes.map((_, i) =>
    fastSeries[i] === null || slowSeries[i] === null ? null : fastSeries[i] - slowSeries[i]
  );
  const tail = macdSeries.slice(-lookback);
  if (tail.some((v) => v === null) || tail.length < lookback) return null;

  const rising = tail.every((v, i) => i === 0 || v >= tail[i - 1]);
  const falling = tail.every((v, i) => i === 0 || v <= tail[i - 1]);
  if (rising && !falling) return "rising";
  if (falling && !rising) return "falling";
  return "flat";
}

/** Bollinger bands at `deviations` standard deviations over `period` closes. */
export function bollingerBands(closes, period, deviations) {
  if (closes.length < period) return { middle: null, upper: null, lower: null };
  const window = closes.slice(closes.length - period);
  const mean = window.reduce((a, b) => a + b, 0) / period;
  const variance = window.reduce((a, b) => a + (b - mean) ** 2, 0) / period;
  const sd = Math.sqrt(variance);
  return { middle: mean, upper: mean + deviations * sd, lower: mean - deviations * sd };
}

/**
 * Fibonacci retracement fraction of the current close within [swingLow, swingHigh]
 * for a bullish continuation (0 = at the high, 1 = fully retraced to the low).
 * Direction is the caller's responsibility: pass swing points appropriate to
 * the hypothesis being tested (bullish pullback vs. bearish rally).
 */
export function retracementFraction(swingHigh, swingLow, currentClose) {
  const range = swingHigh - swingLow;
  if (range <= 0) return null;
  return (swingHigh - currentClose) / range;
}

/** Highest high / lowest low over the trailing `period` bars (for average-volume and swing lookups). */
export function averageVolume(volumes, period) {
  return sma(volumes, period);
}

export function highestHigh(highs, period) {
  if (highs.length < period) return null;
  return Math.max(...highs.slice(highs.length - period));
}

export function lowestLow(lows, period) {
  if (lows.length < period) return null;
  return Math.min(...lows.slice(lows.length - period));
}

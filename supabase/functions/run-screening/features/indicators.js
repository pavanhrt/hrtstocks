// Deterministic technical-indicator calculations over OHLCV bar arrays.
// Bars are oldest-first: [{ date, open, high, low, close, volume }, ...].
//
// RSI period (14), Stochastic (14,3,3), Bollinger (20, 2SD) and volume
// lookback (20) were resolved into config/parameters.yaml's `documented`
// section in parameter_version 1.1.0, sourced from the BUY/SELL Signal
// Playbooks' Stage 0 data tables (see that file's `source` field). ADX/DMI
// and ATR periods remain unresolved and are NOT implemented here -- no
// gate in strategies/buy-signal-playbook.yaml or sell-signal-playbook.yaml
// needs them yet, and per the null_policy a parameter is only marked
// documented once code actually depends on the specific value.

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

/** Rolling SMA series (same length as input); an entry is null until a full null-free window exists. */
function smaSeries(values, period) {
  const out = new Array(values.length).fill(null);
  for (let i = period - 1; i < values.length; i++) {
    const window = values.slice(i - period + 1, i + 1);
    if (window.some((v) => v === null)) continue;
    out[i] = window.reduce((a, b) => a + b, 0) / period;
  }
  return out;
}

/** Wilder-smoothed RSI series (same length as input, leading `period` entries null). */
function rsiSeries(closes, period) {
  const out = new Array(closes.length).fill(null);
  if (closes.length < period + 1) return out;
  let gainSum = 0;
  let lossSum = 0;
  for (let i = 1; i <= period; i++) {
    const diff = closes[i] - closes[i - 1];
    if (diff >= 0) gainSum += diff;
    else lossSum -= diff;
  }
  let avgGain = gainSum / period;
  let avgLoss = lossSum / period;
  out[period] = avgLoss === 0 ? 100 : 100 - 100 / (1 + avgGain / avgLoss);
  for (let i = period + 1; i < closes.length; i++) {
    const diff = closes[i] - closes[i - 1];
    const gain = diff > 0 ? diff : 0;
    const loss = diff < 0 ? -diff : 0;
    avgGain = (avgGain * (period - 1) + gain) / period;
    avgLoss = (avgLoss * (period - 1) + loss) / period;
    out[i] = avgLoss === 0 ? 100 : 100 - 100 / (1 + avgGain / avgLoss);
  }
  return out;
}

/** Latest RSI value, or null if there isn't a full `period + 1` bars of history. */
export function rsi(closes, period) {
  const series = rsiSeries(closes, period);
  return series[series.length - 1];
}

/** Latest and previous RSI values, for crossover/uptick detection. */
export function rsiWithPrevious(closes, period) {
  const series = rsiSeries(closes, period);
  return { value: series[series.length - 1], previous: series[series.length - 2] ?? null };
}

/**
 * Slow stochastic: raw %K over `lookback`, smoothed by `kSmoothing` to give
 * "slow %K", then smoothed again by `dSmoothing` to give %D -- the standard
 * (14, 3, 3) convention the playbooks document.
 */
function stochasticSeries(highs, lows, closes, lookback, kSmoothing, dSmoothing) {
  const rawK = closes.map((close, i) => {
    if (i < lookback - 1) return null;
    const hh = Math.max(...highs.slice(i - lookback + 1, i + 1));
    const ll = Math.min(...lows.slice(i - lookback + 1, i + 1));
    return hh === ll ? null : (100 * (close - ll)) / (hh - ll);
  });
  const k = smaSeries(rawK, kSmoothing);
  const d = smaSeries(k, dSmoothing);
  return { k, d };
}

/** Latest and previous %K/%D, for crossover detection. */
export function stochastic(highs, lows, closes, lookback, kSmoothing, dSmoothing) {
  const { k, d } = stochasticSeries(highs, lows, closes, lookback, kSmoothing, dSmoothing);
  return {
    k: k[k.length - 1],
    d: d[d.length - 1],
    kPrevious: k[k.length - 2] ?? null,
    dPrevious: d[d.length - 2] ?? null,
  };
}

/** Full MACD histogram series (same length as input, leading entries null). */
function macdHistogramSeries(closes, fastPeriod, slowPeriod, signalPeriod) {
  const fastSeries = emaSeries(closes, fastPeriod);
  const slowSeries = emaSeries(closes, slowPeriod);
  const macdSeries = closes.map((_, i) =>
    fastSeries[i] === null || slowSeries[i] === null ? null : fastSeries[i] - slowSeries[i]
  );
  const validStart = macdSeries.findIndex((v) => v !== null);
  const histogram = new Array(closes.length).fill(null);
  if (validStart === -1) return histogram;
  const validMacd = macdSeries.slice(validStart);
  const signalSeries = emaSeries(validMacd, signalPeriod);
  for (let i = 0; i < validMacd.length; i++) {
    if (signalSeries[i] === null) continue;
    histogram[validStart + i] = validMacd[i] - signalSeries[i];
  }
  return histogram;
}

/**
 * Classifies the MACD histogram's most recent bar-on-bar move ("uptick" /
 * "downtick" / "flat") and the phase of the bars immediately before it
 * ("up" / "down" / "flat") -- the two readings the playbooks' M4b/S4b and
 * M7/S7 Step 1 gates combine ("uptick, or flat after a down phase").
 *
 * The playbooks describe this as a visual read ("bar on bar"); this function
 * operationalizes it with two disclosed, non-documented implementation
 * choices: a flat/uptick/downtick boundary of 2% of the prior bar's absolute
 * size (the source material gives no numeric tolerance for "flat"), and a
 * `lookback` of 4 bars (the current bar plus 3 prior) to establish the phase
 * that preceded it.
 */
export function macdHistogramPhase(closes, fastPeriod, slowPeriod, signalPeriod, lookback = 4) {
  const histogram = macdHistogramSeries(closes, fastPeriod, slowPeriod, signalPeriod);
  const tail = histogram.slice(-lookback);
  if (tail.length < lookback || tail.some((v) => v === null)) {
    return { change: null, priorPhase: null };
  }
  const last = tail[tail.length - 1];
  const prev = tail[tail.length - 2];
  const eps = Math.abs(prev) * 0.02;
  let change;
  if (last > prev + eps) change = "uptick";
  else if (last < prev - eps) change = "downtick";
  else change = "flat";

  const priorTail = tail.slice(0, -1);
  let risingCount = 0;
  let fallingCount = 0;
  for (let i = 1; i < priorTail.length; i++) {
    if (priorTail[i] > priorTail[i - 1]) risingCount++;
    else if (priorTail[i] < priorTail[i - 1]) fallingCount++;
  }
  let priorPhase;
  if (fallingCount > risingCount) priorPhase = "down";
  else if (risingCount > fallingCount) priorPhase = "up";
  else priorPhase = "flat";

  return { change, priorPhase };
}

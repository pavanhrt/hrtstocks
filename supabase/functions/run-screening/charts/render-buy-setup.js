// Daily and 15-minute chart rendering for the /buy-setup-analysis page.
// Deliberately a NEW, small module rather than extending charts/render.js
// (used by Direction/swing-analysis and already covered by its own tests) --
// this page's overlay set (EMA lines, pattern labels, support/resistance,
// breakout marker, channel boundaries, volume, Bollinger bands, wave labels,
// oscillator sub-panels, divergence lines) is materially larger, and keeping
// it separate means neither renderer can accidentally regress the other.
// Same approach as render.js: hand-built SVG string, no chart library, no
// headless browser/canvas dependency -- runs fine inside the Deno Edge
// Function. Every annotation drawn here must come from a value the caller
// already computed (buy-setup/*.js) -- this module never infers or
// recalculates evidence, it only positions what it is given.

export const BUY_SETUP_RENDER_VERSION = "1.0.0";
export const MAX_BARS = 90;

const WIDTH = 960;
const MARGIN = { top: 40, right: 24, bottom: 24, left: 64 };
const BG = "#0d1117";
const GRID = "#21262d";
const TEXT = "#c9d1d9";
const TEXT_DIM = "#8b949e";
const UP = "#3fb950";
const DOWN = "#f85149";
const EMA_FAST_COLOR = "#58a6ff";
const EMA_SLOW_COLOR = "#d29922";
const SUPPORT_COLOR = "#3fb950";
const RESISTANCE_COLOR = "#f85149";
const BREAKOUT_COLOR = "#e3b341";
const CHANNEL_COLOR = "#a371f7";
const BOLLINGER_COLOR = "#8b949e";
const CONFIRMED_WAVE_COLOR = "#3fb950";
const TENTATIVE_WAVE_COLOR = "#d29922";
const DIVERGENCE_COLOR = "#e3b341";

function esc(text) {
  return String(text).replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]));
}

function emptyChart(title, height = 320) {
  return `<svg viewBox="0 0 ${WIDTH} ${height}" xmlns="http://www.w3.org/2000/svg"><rect x="0" y="0" width="${WIDTH}" height="${height}" fill="${BG}"/><text x="${MARGIN.left}" y="28" fill="${TEXT}" font-size="16" font-family="sans-serif" font-weight="bold">${esc(title)}</text><text x="${MARGIN.left}" y="${height / 2}" fill="${TEXT_DIM}" font-size="12" font-family="sans-serif">Not enough bars to render a chart</text></svg>`;
}

function scales(window, plotHeight, plotTop, extraLevels = []) {
  const highs = window.map((b) => b.high);
  const lows = window.map((b) => b.low);
  const allValues = [...highs, ...lows, ...extraLevels.filter((v) => v != null)];
  const high = Math.max(...allValues);
  const low = Math.min(...allValues);
  const pad = (high - low) * 0.08 || 1;
  const yMax = high + pad;
  const yMin = low - pad;
  const y = (price) => plotTop + ((yMax - price) / (yMax - yMin)) * plotHeight;
  return { yMax, yMin, y };
}

function drawCandles(window, x, y, candleWidth) {
  return window
    .map((bar, i) => {
      const color = bar.close >= bar.open ? UP : DOWN;
      const cx = x(i);
      const bodyTop = y(Math.max(bar.open, bar.close));
      const bodyBottom = y(Math.min(bar.open, bar.close));
      const bodyHeight = Math.max(1, bodyBottom - bodyTop);
      return (
        `<line x1="${cx}" y1="${y(bar.high)}" x2="${cx}" y2="${y(bar.low)}" stroke="${color}" stroke-width="1"/>` +
        `<rect x="${cx - candleWidth / 2}" y="${bodyTop}" width="${candleWidth}" height="${bodyHeight}" fill="${color}"/>`
      );
    })
    .join("");
}

function drawEmaLine(series, window, startIdx, x, y, color) {
  const points = [];
  for (let i = 0; i < window.length; i++) {
    const v = series[startIdx + i];
    if (v == null) continue;
    points.push(`${x(i)},${y(v)}`);
  }
  if (points.length < 2) return "";
  return `<polyline points="${points.join(" ")}" fill="none" stroke="${color}" stroke-width="1.5"/>`;
}

const EMA_CROSSOVER_MARKER_COLOR = "#3fb950";

/** An explicit upward-triangle marker below the bar where a fast/slow EMA crossover was confirmed -- distinct from the two EMA lines simply visually crossing, per the requirement for an explicit crossover marker. */
function drawEmaCrossoverMarker(crossoverBarDate, dateIndex, x, yLowFn, window) {
  if (!crossoverBarDate || !dateIndex.has(crossoverBarDate)) return "";
  const idx = dateIndex.get(crossoverBarDate);
  const cx = x(idx);
  const cy = yLowFn(window[idx].low) + 14;
  return `<polygon points="${cx - 5},${cy + 8} ${cx + 5},${cy + 8} ${cx},${cy - 2}" fill="${EMA_CROSSOVER_MARKER_COLOR}"/><text x="${cx}" y="${cy + 20}" fill="${EMA_CROSSOVER_MARKER_COLOR}" font-size="8" font-family="monospace" text-anchor="middle">EMA x</text>`;
}

function drawHorizontalLevel(price, label, color, y, dashed = true) {
  if (price == null) return "";
  const gy = y(price);
  return (
    `<line x1="${MARGIN.left}" y1="${gy}" x2="${WIDTH - MARGIN.right}" y2="${gy}" stroke="${color}" stroke-width="1" ${dashed ? 'stroke-dasharray="5 3"' : ""}/>` +
    `<text x="${WIDTH - MARGIN.right - 4}" y="${gy - 3}" fill="${color}" font-size="10" font-family="monospace" text-anchor="end">${esc(label)}: ${price.toFixed(2)}</text>`
  );
}

/**
 * Renders the daily chart: candles, volume, up to two EMA lines, candlestick
 * pattern labels, support/resistance, a breakout marker, and channel
 * boundaries. Every overlay is optional and simply omitted when the caller
 * has no evidence for it (never inferred by this function).
 *
 * @param {object} args
 * @param {string} args.symbol
 * @param {import("../providers/types.js").Bar[]} args.bars oldest-first daily bars
 * @param {{fastPeriod:number, slowPeriod:number, fastSeries:(number|null)[], slowSeries:(number|null)[]}|null} args.ema
 * @param {{status:string, crossoverBarDate:string|null}|null} args.emaCrossover
 * @param {{patternName:string, direction:string, state:string, triggerBarDate:string|null}[]} args.patterns
 * @param {{level:number|null, touchCount:number}|null} args.support
 * @param {{level:number|null, touchCount:number}|null} args.resistance
 * @param {{breakoutDetected:boolean|null, breakoutCandleDate:string|null, breakoutVolumeConfirmed:boolean|null}|null} args.breakout
 * @param {{type:string, upper:number|null, lower:number|null}|null} args.channel
 */
export function renderDailyChart({ symbol, bars, ema, emaCrossover, patterns = [], support, resistance, breakout, channel }) {
  const window = (bars ?? []).slice(-MAX_BARS);
  if (window.length < 2) return emptyChart(`${symbol} · daily`);

  const height = 420;
  const volumeHeight = 60;
  const plotTop = MARGIN.top;
  const plotHeight = height - MARGIN.top - MARGIN.bottom - volumeHeight - 8;
  const plotWidth = WIDTH - MARGIN.left - MARGIN.right;

  const extraLevels = [support?.level, resistance?.level, channel?.upper, channel?.lower].filter((v) => v != null);
  const { y, yMin, yMax } = scales(window, plotHeight, plotTop, extraLevels);
  const xStep = plotWidth / window.length;
  const x = (i) => MARGIN.left + i * xStep + xStep / 2;
  const candleWidth = Math.max(1, Math.min(8, xStep * 0.6));
  const startIdx = bars.length - window.length;
  const dateIndex = new Map(window.map((bar, i) => [bar.date, i]));

  const gridLines = Array.from({ length: 4 }, (_, i) => {
    const price = yMin + ((yMax - yMin) / 4) * (i + 1);
    const gy = y(price);
    return (
      `<line x1="${MARGIN.left}" y1="${gy}" x2="${WIDTH - MARGIN.right}" y2="${gy}" stroke="${GRID}" stroke-width="1"/>` +
      `<text x="${MARGIN.left - 8}" y="${gy + 4}" fill="${TEXT_DIM}" font-size="10" font-family="monospace" text-anchor="end">${price.toFixed(2)}</text>`
    );
  }).join("");

  const candles = drawCandles(window, x, y, candleWidth);
  const emaFastLine = ema?.fastSeries ? drawEmaLine(ema.fastSeries, window, startIdx, x, y, EMA_FAST_COLOR) : "";
  const emaSlowLine = ema?.slowSeries ? drawEmaLine(ema.slowSeries, window, startIdx, x, y, EMA_SLOW_COLOR) : "";
  const emaLegend = ema
    ? `<text x="${MARGIN.left}" y="${plotTop - 12}" fill="${EMA_FAST_COLOR}" font-size="10" font-family="monospace">EMA${ema.fastPeriod}</text>` +
      `<text x="${MARGIN.left + 60}" y="${plotTop - 12}" fill="${EMA_SLOW_COLOR}" font-size="10" font-family="monospace">EMA${ema.slowPeriod}</text>`
    : "";

  const emaCrossoverMarker =
    emaCrossover?.status === "TRIGGERED" ? drawEmaCrossoverMarker(emaCrossover.crossoverBarDate, dateIndex, x, y, window) : "";

  const supportLine = support?.level != null ? drawHorizontalLevel(support.level, "Support", SUPPORT_COLOR, y) : "";
  const resistanceLine = resistance?.level != null ? drawHorizontalLevel(resistance.level, "Resistance", RESISTANCE_COLOR, y) : "";
  const channelLines =
    channel && channel.type !== "NOT_APPLICABLE"
      ? drawHorizontalLevel(channel.upper, `Channel (${channel.type}) upper`, CHANNEL_COLOR, y, false) +
        drawHorizontalLevel(channel.lower, `Channel (${channel.type}) lower`, CHANNEL_COLOR, y, false)
      : "";

  const breakoutMarker =
    breakout?.breakoutDetected && breakout.breakoutCandleDate && dateIndex.has(breakout.breakoutCandleDate)
      ? (() => {
          const idx = dateIndex.get(breakout.breakoutCandleDate);
          const cx = x(idx);
          return (
            `<line x1="${cx}" y1="${plotTop}" x2="${cx}" y2="${plotTop + plotHeight}" stroke="${BREAKOUT_COLOR}" stroke-width="1" stroke-dasharray="2 2"/>` +
            `<text x="${cx}" y="${plotTop - 2}" fill="${BREAKOUT_COLOR}" font-size="10" font-family="monospace" text-anchor="middle">${breakout.breakoutVolumeConfirmed ? "BREAKOUT" : "breakout (no vol.)"}</text>`
          );
        })()
      : "";

  const patternLabels = patterns
    .filter((p) => p.triggerBarDate && dateIndex.has(p.triggerBarDate))
    .map((p, i) => {
      const idx = dateIndex.get(p.triggerBarDate);
      const cx = x(idx);
      const cy = y(window[idx].high) - 14 - (i % 3) * 12;
      const color = p.direction === "bullish" ? UP : DOWN;
      return `<text x="${cx}" y="${cy}" fill="${color}" font-size="9" font-family="monospace" text-anchor="middle">${esc(p.patternName)}</text>`;
    })
    .join("");

  const volumeTop = plotTop + plotHeight + 8;
  const maxVolume = Math.max(...window.map((b) => b.volume), 1);
  const volumeBars = window
    .map((bar, i) => {
      const color = bar.close >= bar.open ? UP : DOWN;
      const barHeight = Math.max(1, (bar.volume / maxVolume) * volumeHeight);
      return `<rect x="${x(i) - candleWidth / 2}" y="${volumeTop + volumeHeight - barHeight}" width="${candleWidth}" height="${barHeight}" fill="${color}" opacity="0.6"/>`;
    })
    .join("");

  return `<svg viewBox="0 0 ${WIDTH} ${height}" xmlns="http://www.w3.org/2000/svg">
  <rect x="0" y="0" width="${WIDTH}" height="${height}" fill="${BG}"/>
  <text x="${MARGIN.left}" y="28" fill="${TEXT}" font-size="16" font-family="sans-serif" font-weight="bold">${esc(symbol)} · daily</text>
  ${emaLegend}
  ${gridLines}
  ${channelLines}
  ${supportLine}
  ${resistanceLine}
  ${candles}
  ${emaFastLine}
  ${emaSlowLine}
  ${emaCrossoverMarker}
  ${breakoutMarker}
  ${patternLabels}
  <text x="${MARGIN.left}" y="${volumeTop - 2}" fill="${TEXT_DIM}" font-size="9" font-family="sans-serif">Volume</text>
  ${volumeBars}
</svg>`;
}

/**
 * Renders the 15-minute chart: candles, EMA lines, Bollinger bands, GUE wave
 * pivot labels (confirmed vs tentative drawn distinctly), bullish divergence
 * lines, and stacked RSI/Stochastic/MACD/DMI-ADX sub-panels.
 *
 * @param {object} args
 * @param {string} args.symbol
 * @param {import("../providers/types.js").Bar[]} args.bars oldest-first, 15-minute
 * @param {{fastPeriod:number, slowPeriod:number, fastSeries:(number|null)[], slowSeries:(number|null)[]}|null} args.ema
 * @param {{upperSeries:(number|null)[], middleSeries:(number|null)[], lowerSeries:(number|null)[]}|null} args.bollinger
 * @param {{pivotPrices: {type:string, price:number, date:string}[]|null, confidence:string, currentWave:string|null}|null} args.wave
 * @param {{indicator:string, pricePivot1:object|null, pricePivot2:object|null, result:string}[]} args.divergences
 * @param {(number|null)[]} args.rsiSeries
 * @param {{kSeries:(number|null)[], dSeries:(number|null)[]}|null} args.stochastic
 * @param {{macdSeries:(number|null)[], signalSeries:(number|null)[], histogramSeries:(number|null)[]}|null} args.macd
 * @param {{plusDiSeries:(number|null)[], minusDiSeries:(number|null)[], adxSeries:(number|null)[]}|null} args.dmi
 */
export function renderIntradayChart({ symbol, bars, ema, emaCrossover, bollinger, wave, divergences = [], rsiSeries, stochastic, macd, dmi }) {
  const window = (bars ?? []).slice(-MAX_BARS);
  if (window.length < 2) return emptyChart(`${symbol} · 15m`, 620);

  const panelHeight = 90;
  const priceHeight = 260;
  const gap = 10;
  const panels = [rsiSeries, stochastic, macd, dmi].filter(Boolean).length;
  const height = MARGIN.top + priceHeight + gap + panels * (panelHeight + gap) + MARGIN.bottom;

  const plotWidth = WIDTH - MARGIN.left - MARGIN.right;
  const xStep = plotWidth / window.length;
  const x = (i) => MARGIN.left + i * xStep + xStep / 2;
  const candleWidth = Math.max(1, Math.min(6, xStep * 0.6));
  const startIdx = bars.length - window.length;
  const dateIndex = new Map(window.map((bar, i) => [bar.date, i]));

  const priceTop = MARGIN.top;
  const bollingerExtra = bollinger ? [bollinger.upperSeries?.[bars.length - 1], bollinger.lowerSeries?.[bars.length - 1]] : [];
  const { y: priceY, yMin, yMax } = scales(window, priceHeight, priceTop, bollingerExtra.filter((v) => v != null));

  const priceGrid = Array.from({ length: 3 }, (_, i) => {
    const price = yMin + ((yMax - yMin) / 3) * (i + 1);
    const gy = priceY(price);
    return `<line x1="${MARGIN.left}" y1="${gy}" x2="${WIDTH - MARGIN.right}" y2="${gy}" stroke="${GRID}" stroke-width="1"/><text x="${MARGIN.left - 8}" y="${gy + 4}" fill="${TEXT_DIM}" font-size="9" font-family="monospace" text-anchor="end">${price.toFixed(2)}</text>`;
  }).join("");

  const candles = drawCandles(window, x, priceY, candleWidth);
  const emaFastLine = ema?.fastSeries ? drawEmaLine(ema.fastSeries, window, startIdx, x, priceY, EMA_FAST_COLOR) : "";
  const emaSlowLine = ema?.slowSeries ? drawEmaLine(ema.slowSeries, window, startIdx, x, priceY, EMA_SLOW_COLOR) : "";
  const bollingerUpper = bollinger?.upperSeries ? drawEmaLine(bollinger.upperSeries, window, startIdx, x, priceY, BOLLINGER_COLOR) : "";
  const bollingerMiddle = bollinger?.middleSeries ? drawEmaLine(bollinger.middleSeries, window, startIdx, x, priceY, BOLLINGER_COLOR) : "";
  const bollingerLower = bollinger?.lowerSeries ? drawEmaLine(bollinger.lowerSeries, window, startIdx, x, priceY, BOLLINGER_COLOR) : "";
  const emaCrossoverMarker =
    emaCrossover?.status === "TRIGGERED" ? drawEmaCrossoverMarker(emaCrossover.crossoverBarDate, dateIndex, x, priceY, window) : "";

  const wavePivotMarkers = (wave?.pivotPrices ?? [])
    .filter((p) => dateIndex.has(p.date))
    .map((p, i, arr) => {
      const idx = dateIndex.get(p.date);
      const cx = x(idx);
      const cy = priceY(p.price);
      const isLast = i === arr.length - 1;
      const confirmed = wave.confidence === "confirmed" || !isLast;
      const color = confirmed ? CONFIRMED_WAVE_COLOR : TENTATIVE_WAVE_COLOR;
      const label = isLast && wave.currentWave ? wave.currentWave : p.type;
      return (
        `<circle cx="${cx}" cy="${cy}" r="3" fill="${confirmed ? color : "none"}" stroke="${color}" stroke-width="1.5" ${confirmed ? "" : 'stroke-dasharray="2 1"'}/>` +
        `<text x="${cx}" y="${cy - 8}" fill="${color}" font-size="10" font-family="monospace" text-anchor="middle">${esc(label)}${confirmed ? "" : "?"}</text>`
      );
    })
    .join("");

  const divergenceLines = divergences
    .filter((d) => d.result === "PASS" && d.pricePivot1?.date && d.pricePivot2?.date && dateIndex.has(d.pricePivot1.date) && dateIndex.has(d.pricePivot2.date))
    .map((d) => {
      const i1 = dateIndex.get(d.pricePivot1.date);
      const i2 = dateIndex.get(d.pricePivot2.date);
      const x1 = x(i1);
      const y1 = priceY(d.pricePivot1.price);
      const x2 = x(i2);
      const y2 = priceY(d.pricePivot2.price);
      return (
        `<line x1="${x1}" y1="${y1}" x2="${x2}" y2="${y2}" stroke="${DIVERGENCE_COLOR}" stroke-width="1.5" stroke-dasharray="4 2"/>` +
        `<text x="${x2}" y="${y2 + 16}" fill="${DIVERGENCE_COLOR}" font-size="9" font-family="monospace" text-anchor="middle">${esc(d.indicator)} bull. div.</text>`
      );
    })
    .join("");

  let cursorTop = priceTop + priceHeight + gap;
  const panelSvgs = [];
  if (rsiSeries) {
    panelSvgs.push(renderOscillatorPanel({ title: "RSI", series: [{ values: rsiSeries, color: EMA_FAST_COLOR }], top: cursorTop, height: panelHeight, window, startIdx, x, bounds: [0, 100], refLines: [30, 70] }));
    cursorTop += panelHeight + gap;
  }
  if (stochastic) {
    panelSvgs.push(
      renderOscillatorPanel({
        title: "Stochastic %K/%D",
        series: [
          { values: stochastic.kSeries, color: EMA_FAST_COLOR },
          { values: stochastic.dSeries, color: EMA_SLOW_COLOR },
        ],
        top: cursorTop,
        height: panelHeight,
        window,
        startIdx,
        x,
        bounds: [0, 100],
        refLines: [20, 80],
      })
    );
    cursorTop += panelHeight + gap;
  }
  if (macd) {
    panelSvgs.push(
      renderOscillatorPanel({
        title: "MACD",
        series: [
          { values: macd.macdSeries, color: EMA_FAST_COLOR },
          { values: macd.signalSeries, color: EMA_SLOW_COLOR },
        ],
        histogram: macd.histogramSeries,
        top: cursorTop,
        height: panelHeight,
        window,
        startIdx,
        x,
      })
    );
    cursorTop += panelHeight + gap;
  }
  if (dmi) {
    panelSvgs.push(
      renderOscillatorPanel({
        title: "+DI / -DI / ADX",
        series: [
          { values: dmi.plusDiSeries, color: UP },
          { values: dmi.minusDiSeries, color: DOWN },
          { values: dmi.adxSeries, color: TEXT_DIM },
        ],
        top: cursorTop,
        height: panelHeight,
        window,
        startIdx,
        x,
        bounds: [0, 100],
      })
    );
  }

  return `<svg viewBox="0 0 ${WIDTH} ${height}" xmlns="http://www.w3.org/2000/svg">
  <rect x="0" y="0" width="${WIDTH}" height="${height}" fill="${BG}"/>
  <text x="${MARGIN.left}" y="28" fill="${TEXT}" font-size="16" font-family="sans-serif" font-weight="bold">${esc(symbol)} · 15m</text>
  ${priceGrid}
  ${bollingerUpper}
  ${bollingerMiddle}
  ${bollingerLower}
  ${candles}
  ${emaFastLine}
  ${emaSlowLine}
  ${emaCrossoverMarker}
  ${wavePivotMarkers}
  ${divergenceLines}
  ${panelSvgs.join("\n")}
</svg>`;
}

function renderOscillatorPanel({ title, series, histogram, top, height, window, startIdx, x, bounds, refLines = [] }) {
  const values = series.flatMap((s) => (s.values ?? []).slice(startIdx, startIdx + window.length)).filter((v) => v != null);
  const histValues = histogram ? histogram.slice(startIdx, startIdx + window.length).filter((v) => v != null) : [];
  const allValues = [...values, ...histValues];
  const [minBound, maxBound] = bounds ?? [Math.min(...allValues, 0), Math.max(...allValues, 0)];
  const y = (v) => top + height - ((v - minBound) / (maxBound - minBound || 1)) * height;

  const border = `<rect x="${MARGIN.left}" y="${top}" width="${WIDTH - MARGIN.left - MARGIN.right}" height="${height}" fill="none" stroke="${GRID}" stroke-width="1"/>`;
  const label = `<text x="${MARGIN.left}" y="${top - 2}" fill="${TEXT_DIM}" font-size="10" font-family="sans-serif">${esc(title)}</text>`;
  const refs = refLines
    .map((v) => `<line x1="${MARGIN.left}" y1="${y(v)}" x2="${WIDTH - MARGIN.right}" y2="${y(v)}" stroke="${GRID}" stroke-width="1" stroke-dasharray="2 2"/>`)
    .join("");
  const histBars = histogram
    ? window
        .map((_, i) => {
          const v = histogram[startIdx + i];
          if (v == null) return "";
          const zero = y(0);
          const py = y(v);
          const color = v >= 0 ? UP : DOWN;
          return `<rect x="${x(i) - 1.5}" y="${Math.min(zero, py)}" width="3" height="${Math.max(1, Math.abs(zero - py))}" fill="${color}" opacity="0.6"/>`;
        })
        .join("")
    : "";
  const lines = series
    .map((s) => drawEmaLine(s.values, window, startIdx, x, y, s.color))
    .join("");

  return `${border}${label}${refs}${histBars}${lines}`;
}

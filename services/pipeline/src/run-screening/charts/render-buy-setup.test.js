import { test } from "node:test";
import assert from "node:assert/strict";
import { renderDailyChart, renderIntradayChart } from "./render-buy-setup.js";
import {
  emaSeries,
  rsiSeries as computeRsiSeries,
  stochasticSeries,
  macdLineAndSignalSeries,
  macdHistogramSeries,
  adxSeries,
  bollingerBandsSeries,
} from "../features/indicators.js";

function makeBars(count, startDate = "2026-01-01") {
  const bars = [];
  let price = 100;
  const start = new Date(`${startDate}T00:00:00Z`);
  for (let i = 0; i < count; i++) {
    price += Math.sin(i / 5) * 2;
    const date = new Date(start.getTime() + i * 86400000).toISOString().slice(0, 10);
    bars.push({ date, open: price - 0.5, high: price + 1.5, low: price - 1.5, close: price + 0.3, volume: 1000 + i * 5 });
  }
  return bars;
}

function assertWellFormedSvg(svg) {
  assert.match(svg, /^<svg viewBox="0 0 \d+ \d+"/);
  assert.match(svg, /<\/svg>$/);
  const entities = svg.match(/&[a-zA-Z#][a-zA-Z0-9]*;/g) ?? [];
  for (const entity of entities) {
    assert.ok(["&amp;", "&lt;", "&gt;", "&quot;", "&apos;"].includes(entity), `illegal XML entity ${entity}`);
  }
}

test("renderDailyChart with no overlays still produces a well-formed, empty-overlay chart", () => {
  const bars = makeBars(40);
  const svg = renderDailyChart({ symbol: "NSE_TCS", bars, ema: null, patterns: [], support: null, resistance: null, breakout: null, channel: null });
  assertWellFormedSvg(svg);
  assert.match(svg, /NSE_TCS/);
});

test("renderDailyChart draws EMA legend, support/resistance labels, and a breakout marker when evidence is present", () => {
  const bars = makeBars(40);
  const closes = bars.map((b) => b.close);
  const svg = renderDailyChart({
    symbol: "NSE_TCS",
    bars,
    ema: { fastPeriod: 5, slowPeriod: 13, fastSeries: emaSeries(closes, 5), slowSeries: emaSeries(closes, 13) },
    patterns: [{ patternName: "Bullish Engulfing", direction: "bullish", state: "TRIGGERED", triggerBarDate: bars[30].date }],
    support: { level: 95, touchCount: 2 },
    resistance: { level: 110, touchCount: 2 },
    breakout: { breakoutDetected: true, breakoutCandleDate: bars[35].date, breakoutVolumeConfirmed: true },
    channel: { type: "rising", upper: 115, lower: 90 },
  });
  assertWellFormedSvg(svg);
  assert.match(svg, /EMA5/);
  assert.match(svg, /Support/);
  assert.match(svg, /Resistance/);
  assert.match(svg, /BREAKOUT/);
  assert.match(svg, /Bullish Engulfing/);
});

test("renderDailyChart draws an explicit EMA crossover marker (polygon) only when status is TRIGGERED", () => {
  const bars = makeBars(40);
  const closes = bars.map((b) => b.close);
  const withoutCrossover = renderDailyChart({ symbol: "NSE_TCS", bars, ema: { fastPeriod: 5, slowPeriod: 13, fastSeries: emaSeries(closes, 5), slowSeries: emaSeries(closes, 13) }, emaCrossover: { status: "NOT_TRIGGERED", crossoverBarDate: null } });
  assert.doesNotMatch(withoutCrossover, /EMA x/);

  const withCrossover = renderDailyChart({
    symbol: "NSE_TCS",
    bars,
    ema: { fastPeriod: 5, slowPeriod: 13, fastSeries: emaSeries(closes, 5), slowSeries: emaSeries(closes, 13) },
    emaCrossover: { status: "TRIGGERED", crossoverBarDate: bars[20].date },
  });
  assertWellFormedSvg(withCrossover);
  assert.match(withCrossover, /<polygon /);
  assert.match(withCrossover, /EMA x/);
});

test("renderDailyChart on too few bars falls back to the empty-chart shape without throwing", () => {
  const svg = renderDailyChart({ symbol: "NSE_X", bars: [{ date: "d0", open: 1, high: 1, low: 1, close: 1, volume: 1 }] });
  assertWellFormedSvg(svg);
  assert.match(svg, /Not enough bars/);
});

test("renderIntradayChart renders price panel plus one sub-panel per supplied indicator", () => {
  const bars = makeBars(60, "2026-01-01");
  const closes = bars.map((b) => b.close);
  const rsi = computeRsiSeries(closes, 14);
  const svg = renderIntradayChart({
    symbol: "NSE_TCS",
    bars,
    ema: { fastPeriod: 5, slowPeriod: 13, fastSeries: emaSeries(closes, 5), slowSeries: emaSeries(closes, 13) },
    bollinger: null,
    wave: { pivotPrices: [{ type: "1", price: bars[10].close, date: bars[10].date }], confidence: "tentative", currentWave: "2" },
    divergences: [{ indicator: "rsi", result: "PASS", pricePivot1: { date: bars[10].date, price: bars[10].close }, pricePivot2: { date: bars[40].date, price: bars[40].close } }],
    rsiSeries: rsi,
    stochastic: null,
    macd: null,
    dmi: null,
  });
  assertWellFormedSvg(svg);
  assert.match(svg, /RSI/);
  assert.match(svg, /2\?/); // tentative wave label suffixed with "?"
  assert.match(svg, /rsi bull\. div\./);
});

test("renderIntradayChart with EVERY required element supplied actually draws every one of them", () => {
  const bars = makeBars(80, "2026-01-01");
  const closes = bars.map((b) => b.close);
  const highs = bars.map((b) => b.high);
  const lows = bars.map((b) => b.low);
  const { k, d } = stochasticSeries(highs, lows, closes, 14, 3, 3);
  const { macdSeries, signalSeries } = macdLineAndSignalSeries(closes, 12, 26, 9);
  const histogramSeries = macdHistogramSeries(closes, 12, 26, 9);
  const { plusDI, minusDI, adx } = adxSeries(highs, lows, closes, 14);
  const { upper, middle, lower } = bollingerBandsSeries(closes, 20, 2.0);

  const svg = renderIntradayChart({
    symbol: "NSE_TCS",
    bars,
    ema: { fastPeriod: 5, slowPeriod: 13, fastSeries: emaSeries(closes, 5), slowSeries: emaSeries(closes, 13) },
    emaCrossover: { status: "TRIGGERED", crossoverBarDate: bars[30].date },
    bollinger: { upperSeries: upper, middleSeries: middle, lowerSeries: lower },
    wave: { pivotPrices: [{ type: "1", price: bars[10].close, date: bars[10].date }], confidence: "confirmed", currentWave: "3" },
    divergences: [
      { indicator: "rsi", result: "PASS", pricePivot1: { date: bars[10].date, price: bars[10].close }, pricePivot2: { date: bars[40].date, price: bars[40].close } },
      { indicator: "macd", result: "PASS", pricePivot1: { date: bars[15].date, price: bars[15].close }, pricePivot2: { date: bars[45].date, price: bars[45].close } },
    ],
    rsiSeries: computeRsiSeries(closes, 14),
    stochastic: { kSeries: k, dSeries: d },
    macd: { macdSeries, signalSeries, histogramSeries },
    dmi: { plusDiSeries: plusDI, minusDiSeries: minusDI, adxSeries: adx },
  });

  assertWellFormedSvg(svg);
  // Candlesticks
  assert.ok((svg.match(/<rect /g) ?? []).length > bars.length, "expected candle bodies plus histogram/panel rects");
  // EMA lines + explicit crossover marker
  assert.match(svg, /<polyline /);
  assert.match(svg, /<polygon /);
  assert.match(svg, /EMA x/);
  // Bollinger upper/middle/lower -- three distinct polylines drawn in the bollinger color
  const bollingerLineCount = (svg.match(new RegExp("#8b949e", "g")) ?? []).length;
  assert.ok(bollingerLineCount >= 3, "expected upper, middle, and lower Bollinger lines");
  // Oscillator panel titles
  assert.match(svg, />RSI</);
  assert.match(svg, />Stochastic %K\/%D</);
  assert.match(svg, />MACD</);
  assert.match(svg, />\+DI \/ -DI \/ ADX</);
  // MACD histogram bars (green/red rects distinct from candle/volume rects)
  assert.match(svg, /#3fb950/);
  assert.match(svg, /#f85149/);
  // GUE wave label and both RSI + MACD divergence lines
  assert.match(svg, />3</);
  assert.match(svg, /rsi bull\. div\./);
  assert.match(svg, /macd bull\. div\./);
  assert.equal((svg.match(/stroke-dasharray="4 2"/g) ?? []).length, 2, "expected exactly one divergence line per indicator");
});

test("renderIntradayChart on too few bars falls back to the empty-chart shape without throwing", () => {
  const svg = renderIntradayChart({ symbol: "NSE_X", bars: [{ date: "d0", open: 1, high: 1, low: 1, close: 1, volume: 1 }] });
  assertWellFormedSvg(svg);
});

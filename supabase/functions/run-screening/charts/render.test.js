import { test } from "node:test";
import assert from "node:assert/strict";
import { renderChartSvg } from "./render.js";

function makeBars(count) {
  const bars = [];
  let price = 100;
  for (let i = 0; i < count; i++) {
    price += Math.sin(i / 5) * 2;
    const date = new Date(Date.UTC(2024, 0, 1 + i)).toISOString().slice(0, 10);
    bars.push({ date, open: price - 0.5, high: price + 1.5, low: price - 1.5, close: price + 0.3, volume: 1000 });
  }
  return bars;
}

test("renderChartSvg produces well-formed SVG with the symbol/timeframe title and pivot labels", () => {
  const bars = makeBars(60);
  const pivots = [
    { type: "L", price: bars[5].low, date: bars[5].date },
    { type: "HH", price: bars[20].high, date: bars[20].date },
    { type: "HL", price: bars[35].low, date: bars[35].date },
  ];
  const svg = renderChartSvg({
    symbol: "NSE_TCS",
    timeframe: "daily",
    bars,
    pivots,
    wave: { label: "Impulse wave 5 of 5 (up)", confidence: "confirmed" },
    dowState: "uptrend_intact",
  });

  assert.match(svg, /^<svg viewBox="0 0 960 480"/);
  assert.match(svg, /<\/svg>$/);
  assert.match(svg, /NSE_TCS/);
  assert.match(svg, />HH</);
  assert.match(svg, />HL</);
  assert.match(svg, /Impulse wave 5 of 5 \(up\)/);
  // one candle wick <line> per bar, plus 4 horizontal grid lines
  assert.equal((svg.match(/<line /g) ?? []).length, bars.length + 4);

  // Only XML's five predefined entities are legal without a DOCTYPE -- a named
  // HTML entity like &middot; makes every XML parser (including <img> in a
  // browser) reject the whole file. Regression test for exactly that bug.
  const entities = svg.match(/&[a-zA-Z#][a-zA-Z0-9]*;/g) ?? [];
  for (const entity of entities) {
    assert.ok(["&amp;", "&lt;", "&gt;", "&quot;", "&apos;"].includes(entity), `illegal XML entity: ${entity}`);
  }
});

test("renderChartSvg shows an 'unconfirmed' badge instead of fabricating a wave label", () => {
  const bars = makeBars(30);
  const svg = renderChartSvg({
    symbol: "NSE_TCS",
    timeframe: "weekly",
    bars,
    pivots: [],
    wave: { label: null, confidence: "unconfirmed" },
    dowState: "ambiguous",
  });
  assert.match(svg, /Wave: unconfirmed/);
});

test("renderChartSvg falls back to an empty-chart placeholder instead of throwing on too few bars", () => {
  const svg = renderChartSvg({
    symbol: "NSE_TCS",
    timeframe: "monthly",
    bars: [{ date: "2024-01-01", open: 100, high: 101, low: 99, close: 100, volume: 100 }],
    pivots: [],
    wave: { label: null, confidence: "unconfirmed" },
    dowState: "ambiguous",
  });
  assert.match(svg, /not enough bars to chart/);
});

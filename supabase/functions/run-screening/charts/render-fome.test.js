import { test } from "node:test";
import assert from "node:assert/strict";
import { renderFomeChart, buildFomeChartAltText, FOME_RENDER_VERSION } from "./render-fome.js";

function makeBars(n, start = 100) {
  const bars = [];
  for (let i = 0; i < n; i++) {
    const price = start + i;
    bars.push({ date: `2026-09-${String(i + 1).padStart(2, "0")}`, open: price, high: price + 2, low: price - 2, close: price + 1, volume: 1000 });
  }
  return bars;
}

test("renderFomeChart: too few bars returns an honest empty-chart placeholder, not a fabricated render", () => {
  const svg = renderFomeChart({ symbol: "RELIANCE", timeframe: "daily", bars: [makeBars(1)[0]], support: null, resistance: null });
  assert.match(svg, /Not enough bars/);
  assert.match(svg, /<svg/);
});

test("renderFomeChart: renders candles, support/resistance, target and invalidation levels", () => {
  const svg = renderFomeChart({
    symbol: "RELIANCE",
    timeframe: "daily",
    bars: makeBars(30),
    support: 95,
    resistance: 140,
    target: 145,
    invalidation: 90,
    latestCompletedCandleAt: "2026-09-30",
  });
  assert.match(svg, /Support: 95\.00/);
  assert.match(svg, /Resistance: 140\.00/);
  assert.match(svg, /Target: 145\.00/);
  assert.match(svg, /Invalidation: 90\.00/);
});

test("renderFomeChart: a provisional candle is visually distinct and explicitly labeled, never indistinguishable from a real one", () => {
  const svg = renderFomeChart({
    symbol: "RELIANCE",
    timeframe: "15m",
    bars: makeBars(20),
    provisionalCandle: { ts: "2026-09-30T10:00:00Z", open: 120, high: 121, low: 119, close: 120.5 },
    support: 110,
    resistance: 130,
  });
  assert.match(svg, /PROVISIONAL \(still forming\)/);
  assert.match(svg, /stroke-dasharray="2 1"/); // the provisional candle's own distinct outline style
});

test("renderFomeChart: no provisional candle omits the provisional legend entirely", () => {
  const svg = renderFomeChart({ symbol: "RELIANCE", timeframe: "daily", bars: makeBars(20), support: 100, resistance: 120 });
  assert.doesNotMatch(svg, /PROVISIONAL/);
});

test("renderFomeChart: SVG carries an accessible title/aria-label built from the same evidence being charted", () => {
  const svg = renderFomeChart({
    symbol: "TCS",
    timeframe: "daily",
    bars: makeBars(20),
    support: 100,
    resistance: 120,
    target: 125,
    invalidation: 95,
    latestCompletedCandleAt: "2026-09-20",
  });
  assert.match(svg, /aria-label="TCS daily chart, latest completed candle 2026-09-20, support 100, resistance 120, target 125, invalidation 95"/);
  assert.match(svg, /<title>/);
});

test("buildFomeChartAltText: composes only the fields actually supplied, never invents a missing one", () => {
  const text = buildFomeChartAltText({ symbol: "TCS", timeframe: "daily", latestCompletedCandleAt: null, support: 100, resistance: null, target: null, invalidation: null, isProvisional: false });
  assert.equal(text, "TCS daily chart, support 100");
});

test("FOME_RENDER_VERSION is a stable, versioned string for cache/reproducibility tracking", () => {
  assert.equal(typeof FOME_RENDER_VERSION, "string");
  assert.match(FOME_RENDER_VERSION, /^\d+\.\d+\.\d+$/);
});

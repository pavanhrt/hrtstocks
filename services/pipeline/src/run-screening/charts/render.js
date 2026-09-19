// Renders a self-contained candlestick chart with Dow-theory pivot labels
// and (when confirmed) a wave badge, as an SVG string -- no headless browser
// or canvas dependency, so this runs fine inside the Deno Edge Function.
// Deliberately does not attempt trendline channels or Fibonacci projections
// (see features/wave.js's header) -- function over the visual fidelity of a
// hand-drawn TradingView chart.

// Bump whenever the visual output of renderChartSvg changes in a way that
// should invalidate a previously-cached chart even if the underlying pivots
// didn't move (e.g. a new panel, a color change, a new marker type) --
// direction.js's chart-input hash includes this (problem #7: the hash used
// to exclude the renderer version entirely, so a renderer change couldn't
// force a refresh of already-stored charts).
export const RENDER_VERSION = "2.0.0";

export const MAX_BARS = 120;

const WIDTH = 960;
const HEIGHT = 480;
const MARGIN = { top: 48, right: 24, bottom: 28, left: 64 };
const BG = "#0d1117";
const GRID = "#21262d";
const TEXT = "#c9d1d9";
const TEXT_DIM = "#8b949e";
const UP = "#3fb950";
const DOWN = "#f85149";
const PIVOT_HIGH = "#f0b429";
const PIVOT_LOW = "#58a6ff";
const UNCONFIRMED = "#8b6f2e";

function esc(text) {
  return String(text).replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]));
}

/**
 * @param {object} args
 * @param {string} args.symbol
 * @param {"daily"|"weekly"|"monthly"} args.timeframe
 * @param {import("../providers/types.js").Bar[]} args.bars oldest-first
 * @param {{type: string, price: number, date: string}[]} args.pivots oldest-first, labeled
 * @param {{type: "high"|"low", price: number, date: string}|null} [args.unconfirmedLeg] the
 *   current forming leg -- drawn distinctly (dashed, muted) so it's visually
 *   obvious it hasn't confirmed and can't be mistaken for a real pivot.
 * @param {{label: string|null, confidence: string}} args.wave
 * @param {string} args.dowState
 * @returns {string} SVG markup
 */
export function renderChartSvg({ symbol, timeframe, bars, pivots, unconfirmedLeg = null, wave, dowState }) {
  const window = bars.slice(-MAX_BARS);
  const plotWidth = WIDTH - MARGIN.left - MARGIN.right;
  const plotHeight = HEIGHT - MARGIN.top - MARGIN.bottom;

  if (window.length < 2) {
    return emptyChart(symbol, timeframe);
  }

  const dateIndex = new Map(window.map((bar, i) => [bar.date, i]));
  const visiblePivots = pivots.filter((p) => dateIndex.has(p.date));

  const high = Math.max(...window.map((b) => b.high));
  const low = Math.min(...window.map((b) => b.low));
  const pad = (high - low) * 0.08 || 1;
  const yMax = high + pad;
  const yMin = low - pad;

  const xStep = plotWidth / window.length;
  const x = (i) => MARGIN.left + i * xStep + xStep / 2;
  const y = (price) => MARGIN.top + ((yMax - price) / (yMax - yMin)) * plotHeight;
  const candleWidth = Math.max(1, Math.min(8, xStep * 0.6));

  const candles = window
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

  const zigzagPoints = visiblePivots.map((p) => `${x(dateIndex.get(p.date))},${y(p.price)}`).join(" ");
  const zigzagLine = visiblePivots.length >= 2 ? `<polyline points="${zigzagPoints}" fill="none" stroke="${TEXT_DIM}" stroke-width="1.5" stroke-dasharray="4 2"/>` : "";

  const pivotMarkers = visiblePivots
    .map((p) => {
      const isHighPivot = p.type.endsWith("H") || p.type === "H";
      const cx = x(dateIndex.get(p.date));
      const cy = y(p.price);
      const color = isHighPivot ? PIVOT_HIGH : PIVOT_LOW;
      const labelY = isHighPivot ? cy - 10 : cy + 20;
      return (
        `<circle cx="${cx}" cy="${cy}" r="3" fill="${color}"/>` +
        `<text x="${cx}" y="${labelY}" fill="${color}" font-size="11" font-family="monospace" text-anchor="middle">${esc(p.type)}</text>`
      );
    })
    .join("");

  // The current forming leg (not yet a confirmed pivot) is drawn distinctly
  // -- a hollow, dashed marker with a "?" suffix -- so it can never be
  // mistaken for a confirmed HH/HL/LH/LL and cannot visually imply it has
  // already changed the trend classification.
  const unconfirmedMarker =
    unconfirmedLeg && dateIndex.has(unconfirmedLeg.date)
      ? (() => {
          const cx = x(dateIndex.get(unconfirmedLeg.date));
          const cy = y(unconfirmedLeg.price);
          const isHighLeg = unconfirmedLeg.type === "high";
          const labelY = isHighLeg ? cy - 10 : cy + 20;
          return (
            `<circle cx="${cx}" cy="${cy}" r="4" fill="none" stroke="${UNCONFIRMED}" stroke-width="1.5" stroke-dasharray="2 1"/>` +
            `<text x="${cx}" y="${labelY}" fill="${UNCONFIRMED}" font-size="11" font-family="monospace" text-anchor="middle">${esc(isHighLeg ? "H?" : "L?")}</text>`
          );
        })()
      : "";

  const gridLines = Array.from({ length: 4 }, (_, i) => {
    const price = yMin + ((yMax - yMin) / 4) * (i + 1);
    const gy = y(price);
    return (
      `<line x1="${MARGIN.left}" y1="${gy}" x2="${WIDTH - MARGIN.right}" y2="${gy}" stroke="${GRID}" stroke-width="1"/>` +
      `<text x="${MARGIN.left - 8}" y="${gy + 4}" fill="${TEXT_DIM}" font-size="10" font-family="monospace" text-anchor="end">${price.toFixed(2)}</text>`
    );
  }).join("");

  const waveBadge = renderWaveBadge(wave);

  return `<svg viewBox="0 0 ${WIDTH} ${HEIGHT}" xmlns="http://www.w3.org/2000/svg">
  <rect x="0" y="0" width="${WIDTH}" height="${HEIGHT}" fill="${BG}"/>
  <text x="${MARGIN.left}" y="28" fill="${TEXT}" font-size="16" font-family="sans-serif" font-weight="bold">${esc(symbol)} · ${esc(timeframe)}</text>
  <text x="${MARGIN.left}" y="${HEIGHT - 8}" fill="${TEXT_DIM}" font-size="11" font-family="sans-serif">Dow state: ${esc(dowState)}</text>
  ${waveBadge}
  ${gridLines}
  ${candles}
  ${zigzagLine}
  ${pivotMarkers}
  ${unconfirmedMarker}
</svg>`;
}

function renderWaveBadge(wave) {
  if (!wave || !wave.label) {
    return `<text x="${WIDTH - 24}" y="28" fill="${TEXT_DIM}" font-size="12" font-family="sans-serif" text-anchor="end">Wave: unconfirmed</text>`;
  }
  const color = wave.confidence === "confirmed" ? UP : TEXT_DIM;
  const suffix = wave.confidence === "confirmed" ? "" : " (tentative)";
  return `<text x="${WIDTH - 24}" y="28" fill="${color}" font-size="12" font-family="sans-serif" text-anchor="end">${esc(wave.label)}${suffix}</text>`;
}

function emptyChart(symbol, timeframe) {
  return `<svg viewBox="0 0 ${WIDTH} ${HEIGHT}" xmlns="http://www.w3.org/2000/svg">
  <rect x="0" y="0" width="${WIDTH}" height="${HEIGHT}" fill="${BG}"/>
  <text x="${WIDTH / 2}" y="${HEIGHT / 2}" fill="${TEXT_DIM}" font-size="14" font-family="sans-serif" text-anchor="middle">${esc(symbol)} · ${esc(timeframe)}: not enough bars to chart</text>
</svg>`;
}

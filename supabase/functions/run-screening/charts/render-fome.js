// Daily and 15-minute chart rendering for the /fome page. Deliberately a
// NEW, small module rather than extending charts/render.js or
// charts/render-buy-setup.js (both already covered by their own tests, and
// each page's overlay set differs) -- same convention this project already
// established for render-buy-setup.js: keeping renderers separate means
// none of them can accidentally regress another. Hand-built SVG string, no
// chart library, no headless browser/canvas dependency -- runs fine inside
// the Deno Edge Function.
//
// Every annotation drawn here must come from a value the caller already
// computed (fome/timeframe-direction.js, fome/strategy-comparison.js) --
// this module never infers or recalculates evidence, it only positions what
// it is given. The provisional (still-forming) candle, when present, is
// drawn in a visually distinct color and explicitly labeled -- it must never
// look identical to a close-confirmed candle.

export const FOME_RENDER_VERSION = "1.0.0";
export const MAX_BARS = 90;

const WIDTH = 960;
const HEIGHT = 420;
const MARGIN = { top: 40, right: 24, bottom: 24, left: 64 };
const BG = "#0d1117";
const TEXT = "#c9d1d9";
const TEXT_DIM = "#8b949e";
const UP = "#3fb950";
const DOWN = "#f85149";
const PROVISIONAL_COLOR = "#d29922";
const SUPPORT_COLOR = "#3fb950";
const RESISTANCE_COLOR = "#f85149";
const TARGET_COLOR = "#58a6ff";
const INVALIDATION_COLOR = "#f85149";

function esc(text) {
  return String(text).replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]));
}

function emptyChart(title, reason = "Not enough bars to render a chart") {
  return `<svg viewBox="0 0 ${WIDTH} ${HEIGHT}" xmlns="http://www.w3.org/2000/svg" role="img" aria-label="${esc(title)}: ${esc(reason)}"><rect x="0" y="0" width="${WIDTH}" height="${HEIGHT}" fill="${BG}"/><text x="${MARGIN.left}" y="28" fill="${TEXT}" font-size="16" font-family="sans-serif" font-weight="bold">${esc(title)}</text><text x="${MARGIN.left}" y="${HEIGHT / 2}" fill="${TEXT_DIM}" font-size="12" font-family="sans-serif">${esc(reason)}</text></svg>`;
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
  return { y };
}

function drawCandles(window, x, y, candleWidth, provisionalIndex) {
  return window
    .map((bar, i) => {
      const isProvisional = i === provisionalIndex;
      const color = isProvisional ? PROVISIONAL_COLOR : bar.close >= bar.open ? UP : DOWN;
      const cx = x(i);
      const bodyTop = y(Math.max(bar.open, bar.close));
      const bodyBottom = y(Math.min(bar.open, bar.close));
      const bodyHeight = Math.max(1, bodyBottom - bodyTop);
      const opacity = isProvisional ? 0.65 : 1;
      return (
        `<line x1="${cx}" y1="${y(bar.high)}" x2="${cx}" y2="${y(bar.low)}" stroke="${color}" stroke-width="1" opacity="${opacity}"/>` +
        `<rect x="${cx - candleWidth / 2}" y="${bodyTop}" width="${candleWidth}" height="${bodyHeight}" fill="${color}" opacity="${opacity}" ${isProvisional ? 'stroke="' + PROVISIONAL_COLOR + '" stroke-dasharray="2 1"' : ""}/>`
      );
    })
    .join("");
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
 * Builds an accessible plain-text summary for the SVG's own <title>/aria-label
 * and for a page-level <img alt="...">, per the FOME implementation task's
 * "accessible alternative text" requirement.
 */
export function buildFomeChartAltText({ symbol, timeframe, latestCompletedCandleAt, support, resistance, target, invalidation, isProvisional }) {
  const parts = [`${symbol} ${timeframe} chart`];
  if (latestCompletedCandleAt) parts.push(`latest completed candle ${latestCompletedCandleAt}`);
  if (support != null) parts.push(`support ${support}`);
  if (resistance != null) parts.push(`resistance ${resistance}`);
  if (target != null) parts.push(`target ${target}`);
  if (invalidation != null) parts.push(`invalidation ${invalidation}`);
  if (isProvisional) parts.push("latest candle is provisional (still forming)");
  return parts.join(", ");
}

/**
 * Renders a FOME Daily or 15-minute candlestick chart: support/resistance,
 * target/invalidation (dashed, direction-colored), and -- when the caller
 * supplies one -- a single trailing provisional candle rendered in a
 * visually distinct amber, opacity-reduced, dashed-outline style with its
 * own explicit legend line, never indistinguishable from a close-confirmed
 * candle.
 *
 * @param {object} args
 * @param {string} args.symbol
 * @param {"daily"|"15m"} args.timeframe
 * @param {import("../providers/types.js").Bar[]} args.bars oldest-first, CLOSE-CONFIRMED bars only (never include the provisional candle in this array -- pass it separately)
 * @param {{ts: string, open: number, high: number, low: number, close: number}|null} [args.provisionalCandle] the still-forming trailing candle, if any, shown appended after `bars`
 * @param {number|null} args.support
 * @param {number|null} args.resistance
 * @param {number|null} [args.target]
 * @param {number|null} [args.invalidation]
 * @param {string|null} [args.latestCompletedCandleAt]
 */
export function renderFomeChart({ symbol, timeframe, bars, provisionalCandle = null, support, resistance, target = null, invalidation = null, latestCompletedCandleAt = null }) {
  const closeConfirmed = (bars ?? []).slice(-MAX_BARS);
  const fullWindow = provisionalCandle ? [...closeConfirmed, provisionalCandle] : closeConfirmed;
  const title = `${symbol} · ${timeframe}`;

  if (fullWindow.length < 2) return emptyChart(title);

  const extraLevels = [support, resistance, target, invalidation];
  const plotTop = MARGIN.top;
  const plotHeight = HEIGHT - MARGIN.top - MARGIN.bottom;
  const plotWidth = WIDTH - MARGIN.left - MARGIN.right;
  const { y } = scales(fullWindow, plotHeight, plotTop, extraLevels);
  const step = plotWidth / fullWindow.length;
  const x = (i) => MARGIN.left + step * i + step / 2;
  const candleWidth = Math.max(1, Math.min(8, step * 0.6));
  const provisionalIndex = provisionalCandle ? fullWindow.length - 1 : -1;

  const altText = buildFomeChartAltText({
    symbol,
    timeframe,
    latestCompletedCandleAt,
    support,
    resistance,
    target,
    invalidation,
    isProvisional: Boolean(provisionalCandle),
  });

  const legend = [];
  let legendY = 18;
  if (provisionalCandle) {
    legend.push(`<circle cx="${WIDTH - 180}" cy="${legendY - 4}" r="4" fill="${PROVISIONAL_COLOR}"/><text x="${WIDTH - 170}" y="${legendY}" fill="${PROVISIONAL_COLOR}" font-size="10" font-family="sans-serif">Latest candle: PROVISIONAL (still forming)</text>`);
    legendY += 14;
  }

  return (
    `<svg viewBox="0 0 ${WIDTH} ${HEIGHT}" xmlns="http://www.w3.org/2000/svg" role="img" aria-label="${esc(altText)}">` +
    `<title>${esc(altText)}</title>` +
    `<rect x="0" y="0" width="${WIDTH}" height="${HEIGHT}" fill="${BG}"/>` +
    `<text x="${MARGIN.left}" y="28" fill="${TEXT}" font-size="16" font-family="sans-serif" font-weight="bold">${esc(title)}</text>` +
    legend.join("") +
    drawCandles(fullWindow, x, y, candleWidth, provisionalIndex) +
    drawHorizontalLevel(support, "Support", SUPPORT_COLOR, y) +
    drawHorizontalLevel(resistance, "Resistance", RESISTANCE_COLOR, y) +
    drawHorizontalLevel(target, "Target", TARGET_COLOR, y) +
    drawHorizontalLevel(invalidation, "Invalidation", INVALIDATION_COLOR, y) +
    `</svg>`
  );
}

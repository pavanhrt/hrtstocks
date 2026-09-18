import { test } from "node:test";
import assert from "node:assert/strict";
import { buildFomeRuleContext } from "./rule-context.js";

const documentedParams = { zigzag_daily_pct: 0.025 };

function makeBars(n) {
  const bars = [];
  for (let i = 0; i < n; i++) {
    const wave = Math.sin(i / 3) * 3;
    const price = 100 + i * 1.5 + wave;
    bars.push({
      date: new Date(2020, 0, i + 1).toISOString().slice(0, 10),
      open: price - 1,
      high: price + 2,
      low: price - 2,
      close: price,
      volume: 100000,
    });
  }
  return bars;
}

test("buildFomeRuleContext: TLBO/TLBD/Ungali are always null (unresolved), never guessed", () => {
  const dailyRow = { macdState: "rising", rsi: 65, adx: 20, adxSlope: "rising", bollingerState: "flat", dowState: "uptrend_intact" };
  const ctx = buildFomeRuleContext({ dailyBars: makeBars(80), dailyRow, documentedParams, derivative: null });
  assert.equal(ctx.trendline_breakout, null);
  assert.equal(ctx.trendline_breakdown, null);
  assert.equal(ctx.bullish_ungali, null);
  assert.equal(ctx.bearish_ungali, null);
});

test("buildFomeRuleContext: maps daily row indicators through verbatim", () => {
  const dailyRow = { macdState: "falling", rsi: 32, adx: 18, adxSlope: "falling", bollingerState: "expanding", dowState: "downtrend_intact" };
  const ctx = buildFomeRuleContext({ dailyBars: makeBars(80), dailyRow, documentedParams, derivative: null });
  assert.equal(ctx.tide_macd_slope, "falling");
  assert.equal(ctx.rsi, 32);
  assert.equal(ctx.wave_adx, 18);
  assert.equal(ctx.wave_adx_slope, "falling");
  assert.equal(ctx.bollinger_state, "expanding");
});

test("buildFomeRuleContext: no derivative data leaves every OI-derived input null, never false", () => {
  const dailyRow = { macdState: "rising", rsi: 65, dowState: "uptrend_intact" };
  const ctx = buildFomeRuleContext({ dailyBars: makeBars(80), dailyRow, documentedParams, derivative: null });
  assert.equal(ctx.option_oi_supportive, null);
  assert.equal(ctx.option_oi_supportive_bearish, null);
  assert.equal(ctx.futures_long_buildup, null);
  assert.equal(ctx.futures_short_buildup, null);
});

test("buildFomeRuleContext: derivative data resolves futures OI and option OI supportiveness", () => {
  const dailyRow = { macdState: "rising", rsi: 65, dowState: "uptrend_intact" };
  const derivative = {
    futures: { priceChangePct: 1.2, oiChangePct: 3.0 },
    atmPutOiChangePct: 4,
    atmOrItmCallOiChangePct: -4,
    atmOrItmPutOiChangePct: -4,
    atmCallOiChangePct: 4,
  };
  const ctx = buildFomeRuleContext({ dailyBars: makeBars(80), dailyRow, documentedParams, derivative });
  assert.equal(ctx.futures_long_buildup, true);
  assert.equal(ctx.futures_short_buildup, false);
  assert.equal(ctx.option_oi_supportive, true);
  assert.equal(ctx.option_oi_supportive_bearish, true);
});

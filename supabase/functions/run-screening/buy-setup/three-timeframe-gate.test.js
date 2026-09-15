import { test } from "node:test";
import assert from "node:assert/strict";
import {
  computeDailyDowBullishContext,
  buildThreeTimeframeContext,
  evaluateThreeTimeframeGate,
  isQualifiedForFifteenMinuteAnalysis,
} from "./three-timeframe-gate.js";

// Mirrors strategies/buy-setup-analysis.yaml verbatim (kept inline so this
// test does not depend on YAML parsing/seeding).
const BSA_D1 = {
  rule_id: "BSA-D1",
  name: "Daily Dow structure (bullish)",
  expression: "bsa_daily_dow_state == 'uptrend_intact' or bsa_daily_dow_state == 'confirmed_reversal_bullish' or (bsa_daily_dow_state == 'sideways' and bsa_daily_range_breakout_up_with_volume)",
  inputs: ["bsa_daily_dow_state", "bsa_daily_range_breakout_up_with_volume"],
  true_result: "PASS",
  false_result: "FAIL",
  missing_result: "NO_DATA",
  hard_gate: false,
  source_status: "PROJECT_DEFAULT",
};
const BSA_G1 = {
  rule_id: "BSA-G1",
  name: "Three-timeframe bullish alignment gate",
  expression:
    "(bsa_monthly_dow_state == 'uptrend_intact' or bsa_monthly_dow_state == 'confirmed_reversal_bullish' or (bsa_monthly_dow_state == 'sideways' and bsa_monthly_range_breakout_up_with_volume))" +
    " and (bsa_weekly_dow_state == 'uptrend_intact' or bsa_weekly_dow_state == 'confirmed_reversal_bullish' or (bsa_weekly_dow_state == 'sideways' and bsa_weekly_range_breakout_up_with_volume))" +
    " and (bsa_daily_dow_state == 'uptrend_intact' or bsa_daily_dow_state == 'confirmed_reversal_bullish' or (bsa_daily_dow_state == 'sideways' and bsa_daily_range_breakout_up_with_volume))",
  inputs: [
    "bsa_monthly_dow_state",
    "bsa_monthly_range_breakout_up_with_volume",
    "bsa_weekly_dow_state",
    "bsa_weekly_range_breakout_up_with_volume",
    "bsa_daily_dow_state",
    "bsa_daily_range_breakout_up_with_volume",
  ],
  true_result: "PASS",
  false_result: "FAIL",
  missing_result: "NO_DATA",
  hard_gate: true,
  source_status: "PROJECT_DEFAULT",
};
const BSA_RULES = [BSA_D1, BSA_G1];

function bar(date, open, high, low, close, volume = 1000) {
  return { date, open, high, low, close, volume };
}

function uptrendBars() {
  // Five alternating legs (up/down/up/down/up), each moving comfortably past
  // the 2.5% zigzag threshold, producing a confirmed HH+HL sequence with the
  // final close above the last confirmed low -> uptrend_intact. Verified
  // directly against zigzagPivots/classifyDowStructure (not hand-derived).
  const bars = [];
  let price = 100;
  let i = 0;
  for (const move of [30, -20, 30, -15, 30]) {
    const step = move / 10;
    for (let s = 1; s <= 10; s++) {
      const p = price + step * s;
      bars.push(bar(`d${i++}`, p, p + 1, p - 1, p));
    }
    price += move;
  }
  return bars;
}

function sidewaysBarsNoBreakout() {
  // Oscillates inside a range without ever closing beyond the last swing
  // high/low -- sideways, and the final close stays inside the range so
  // no breakout is even attempted.
  const bars = [];
  const base = 100;
  for (let i = 0; i < 30; i++) {
    const wave = i % 6;
    const px = base + [0, 4, 8, 4, 0, -4][wave];
    bars.push(bar(`s${i}`, px, px + 1, px - 1, px, 1000));
  }
  return bars;
}

function sidewaysBreakoutNoVolumeBars() {
  const bars = sidewaysBarsNoBreakout();
  const last = bars[bars.length - 1];
  // A close comfortably above the established range high, but volume stays
  // at the same flat level as every prior bar -- breakout price condition
  // true, volume confirmation false.
  bars.push(bar("breakout", last.close, last.close + 20, last.close - 1, last.close + 15, 1000));
  return bars;
}

function sidewaysBreakoutWithVolumeBars() {
  const bars = sidewaysBarsNoBreakout();
  const last = bars[bars.length - 1];
  bars.push(bar("breakout", last.close, last.close + 20, last.close - 1, last.close + 15, 5000));
  return bars;
}

const DAILY_PARAMS = { zigzagDailyPct: 0.025, volumeLookback: 20, volumeMultiplier: 1.0 };

test("computeDailyDowBullishContext: uptrend_intact resolves bsa_daily_dow_state to uptrend_intact", () => {
  const ctx = computeDailyDowBullishContext(uptrendBars(), DAILY_PARAMS);
  assert.equal(ctx.bsa_daily_dow_state, "uptrend_intact");
});

test("computeDailyDowBullishContext: sideways without breakout leaves bsa_daily_range_breakout_up_with_volume false/null, never true", () => {
  const ctx = computeDailyDowBullishContext(sidewaysBarsNoBreakout(), DAILY_PARAMS);
  assert.equal(ctx.bsa_daily_dow_state, "sideways");
  assert.notEqual(ctx.bsa_daily_range_breakout_up_with_volume, true);
});

test("computeDailyDowBullishContext: sideways breakout without volume confirmation is not a volume-confirmed breakout", () => {
  const ctx = computeDailyDowBullishContext(sidewaysBreakoutNoVolumeBars(), DAILY_PARAMS);
  assert.equal(ctx.bsa_daily_dow_state, "sideways");
  assert.equal(ctx.bsa_daily_range_breakout_up_with_volume, false);
});

test("computeDailyDowBullishContext: sideways breakout WITH volume confirmation is true", () => {
  const ctx = computeDailyDowBullishContext(sidewaysBreakoutWithVolumeBars(), DAILY_PARAMS);
  assert.equal(ctx.bsa_daily_dow_state, "sideways");
  assert.equal(ctx.bsa_daily_range_breakout_up_with_volume, true);
});

test("computeDailyDowBullishContext: fewer than 2 bars returns null context, never a guess", () => {
  const ctx = computeDailyDowBullishContext([bar("only", 100, 101, 99, 100)], DAILY_PARAMS);
  assert.equal(ctx.bsa_daily_dow_state, null);
  assert.equal(ctx.bsa_daily_range_breakout_up_with_volume, null);
});

test("BSA-D1: each valid bullish Dow state (uptrend_intact, confirmed_reversal_bullish, sideways+breakout+volume) passes", () => {
  for (const state of ["uptrend_intact", "confirmed_reversal_bullish"]) {
    const { traces } = evaluateThreeTimeframeGate([BSA_D1], {
      bsa_daily_dow_state: state,
      bsa_daily_range_breakout_up_with_volume: null,
    });
    assert.equal(traces[0].result, "PASS", `expected PASS for ${state}`);
  }
  const { traces: sidewaysPass } = evaluateThreeTimeframeGate([BSA_D1], {
    bsa_daily_dow_state: "sideways",
    bsa_daily_range_breakout_up_with_volume: true,
  });
  assert.equal(sidewaysPass[0].result, "PASS");
});

test("BSA-D1: sideways alone (no breakout) is not bullish -- FAIL, not PASS", () => {
  const { traces } = evaluateThreeTimeframeGate([BSA_D1], {
    bsa_daily_dow_state: "sideways",
    bsa_daily_range_breakout_up_with_volume: false,
  });
  assert.equal(traces[0].result, "FAIL");
});

test("BSA-D1: sideways breakout without volume confirmation is not bullish -- FAIL", () => {
  const { traces } = evaluateThreeTimeframeGate([BSA_D1], {
    bsa_daily_dow_state: "sideways",
    bsa_daily_range_breakout_up_with_volume: false,
  });
  assert.equal(traces[0].result, "FAIL");
});

test("BSA-D1: downtrend_intact and ambiguous both FAIL, never PASS", () => {
  for (const state of ["downtrend_intact", "ambiguous", "confirmed_reversal_bearish"]) {
    const { traces } = evaluateThreeTimeframeGate([BSA_D1], {
      bsa_daily_dow_state: state,
      bsa_daily_range_breakout_up_with_volume: null,
    });
    assert.equal(traces[0].result, "FAIL", `expected FAIL for ${state}`);
  }
});

test("BSA-D1: missing dow_state is NO_DATA, never PASS or FAIL", () => {
  const { traces } = evaluateThreeTimeframeGate([BSA_D1], {
    bsa_daily_dow_state: null,
    bsa_daily_range_breakout_up_with_volume: null,
  });
  assert.equal(traces[0].result, "NO_DATA");
});

function threeTimeframeContext({ monthly, weekly, daily, monthlyBreakout = null, weeklyBreakout = null, dailyBreakout = null }) {
  return {
    bsa_monthly_dow_state: monthly,
    bsa_monthly_range_breakout_up_with_volume: monthlyBreakout,
    bsa_weekly_dow_state: weekly,
    bsa_weekly_range_breakout_up_with_volume: weeklyBreakout,
    bsa_daily_dow_state: daily,
    bsa_daily_range_breakout_up_with_volume: dailyBreakout,
  };
}

test("BSA-G1: strict AND -- all three bullish passes", () => {
  const ctx = threeTimeframeContext({ monthly: "uptrend_intact", weekly: "uptrend_intact", daily: "uptrend_intact" });
  const { traces } = evaluateThreeTimeframeGate([BSA_G1], ctx);
  assert.equal(traces[0].result, "PASS");
  assert.ok(isQualifiedForFifteenMinuteAnalysis(traces));
});

test("BSA-G1: monthly bullish + weekly bullish but daily NOT bullish -> FAIL (never 2-of-3 PASS)", () => {
  const ctx = threeTimeframeContext({ monthly: "uptrend_intact", weekly: "uptrend_intact", daily: "downtrend_intact" });
  const { traces } = evaluateThreeTimeframeGate([BSA_G1], ctx);
  assert.equal(traces[0].result, "FAIL");
  assert.equal(isQualifiedForFifteenMinuteAnalysis(traces), false);
});

test("BSA-G1: monthly bullish + daily bullish but weekly sideways-no-breakout -> FAIL", () => {
  const ctx = threeTimeframeContext({ monthly: "uptrend_intact", weekly: "sideways", weeklyBreakout: false, daily: "uptrend_intact" });
  const { traces } = evaluateThreeTimeframeGate([BSA_G1], ctx);
  assert.equal(traces[0].result, "FAIL");
});

test("BSA-G1: a known FAIL on one timeframe wins even if another timeframe is NO_DATA (never grants a pass on missing data)", () => {
  const ctx = threeTimeframeContext({ monthly: "downtrend_intact", weekly: null, daily: "uptrend_intact" });
  const { traces } = evaluateThreeTimeframeGate([BSA_G1], ctx);
  assert.equal(traces[0].result, "FAIL");
});

test("BSA-G1: no known FAIL but one timeframe missing -> NO_DATA, never PASS", () => {
  const ctx = threeTimeframeContext({ monthly: "uptrend_intact", weekly: "uptrend_intact", daily: null });
  const { traces } = evaluateThreeTimeframeGate([BSA_G1], ctx);
  assert.equal(traces[0].result, "NO_DATA");
  assert.equal(isQualifiedForFifteenMinuteAnalysis(traces), false);
});

test("BSA-G1: ambiguous direction on any timeframe never resolves to PASS", () => {
  const ctx = threeTimeframeContext({ monthly: "ambiguous", weekly: "uptrend_intact", daily: "uptrend_intact" });
  const { traces } = evaluateThreeTimeframeGate([BSA_G1], ctx);
  assert.notEqual(traces[0].result, "PASS");
});

test("buildThreeTimeframeContext composes monthly/weekly passthrough with freshly computed daily", () => {
  const ctx = buildThreeTimeframeContext({
    monthlyDowState: "uptrend_intact",
    monthlyBreakoutUpWithVolume: null,
    weeklyDowState: "uptrend_intact",
    weeklyBreakoutUpWithVolume: null,
    dailyBars: uptrendBars(),
    params: DAILY_PARAMS,
  });
  assert.equal(ctx.bsa_monthly_dow_state, "uptrend_intact");
  assert.equal(ctx.bsa_weekly_dow_state, "uptrend_intact");
  assert.equal(ctx.bsa_daily_dow_state, "uptrend_intact");
  const { traces } = evaluateThreeTimeframeGate(BSA_RULES, ctx);
  const g1 = traces.find((t) => t.rule_id === "BSA-G1");
  assert.equal(g1.result, "PASS");
});

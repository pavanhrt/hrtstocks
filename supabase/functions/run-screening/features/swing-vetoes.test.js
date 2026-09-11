import { test } from "node:test";
import assert from "node:assert/strict";
import { evaluateSwingVetoes } from "./swing-vetoes.js";

function hbar(date, close) {
  return { date, close, open: close, high: close, low: close, volume: 1000 };
}

const CLEAN_ROUTE = {
  origin: { price: 100 },
  wave1: { price: 141 },
  trigger: { confirmed: true, gapOnly: false, barDate: "T0" },
};
const CLEAN_HOURLY_BARS = [hbar("T0", 145), hbar("T1", 150), hbar("T2", 155)];
const CLEAN_DAILY_STRUCTURE = { state: "uptrend_intact", lastSwingHigh: 200, lastSwingLow: 120 };

test("evaluateSwingVetoes: null route -> no vetoes (nothing to check yet)", () => {
  assert.deepEqual(evaluateSwingVetoes({ route: null, bullish: true, hourlyBars: [], dailyStructure: null, latestDailyClose: null, weeklyMacdHistogramChange: null, rewardRiskRatio: null, minimumRewardRiskStrict: null }), []);
});

test("evaluateSwingVetoes: a fully clean route with no adverse evidence triggers zero vetoes", () => {
  const result = evaluateSwingVetoes({
    route: CLEAN_ROUTE,
    bullish: true,
    hourlyBars: CLEAN_HOURLY_BARS,
    dailyStructure: CLEAN_DAILY_STRUCTURE,
    latestDailyClose: 180,
    weeklyMacdHistogramChange: "uptick",
    rewardRiskRatio: 4.0,
    minimumRewardRiskStrict: 3.0,
  });
  assert.deepEqual(result, []);
});

test("evaluateSwingVetoes: an hourly close below wave 1's origin vetoes (rule 1 breaks)", () => {
  const result = evaluateSwingVetoes({
    route: CLEAN_ROUTE,
    bullish: true,
    hourlyBars: [hbar("T0", 99)], // below origin(100)
    dailyStructure: null,
    latestDailyClose: null,
    weeklyMacdHistogramChange: null,
    rewardRiskRatio: null,
    minimumRewardRiskStrict: null,
  });
  assert.equal(result.length, 1);
  assert.equal(result[0].id, "wave1-origin-breach");
});

test("evaluateSwingVetoes: wave 4 entering wave 1's territory vetoes (rule 2 breaks) -- only checkable when the route carries both fields", () => {
  const sell1Route = { origin: { price: 200 }, wave1: { price: 150 }, wave4: { price: 160 }, trigger: { confirmed: false, gapOnly: false } }; // bearish: wave4(160) is ABOVE wave1(150) -- entered territory
  const result = evaluateSwingVetoes({
    route: sell1Route,
    bullish: false,
    hourlyBars: [hbar("T0", 500)], // well clear of origin, isolates this veto
    dailyStructure: null,
    latestDailyClose: null,
    weeklyMacdHistogramChange: null,
    rewardRiskRatio: null,
    minimumRewardRiskStrict: null,
  });
  assert.ok(result.some((v) => v.id === "wave4-territory-breach"));
});

test("evaluateSwingVetoes: a trigger that only registered on the gap vetoes", () => {
  const gapRoute = { ...CLEAN_ROUTE, trigger: { confirmed: false, gapOnly: true, barDate: "T0" } };
  const result = evaluateSwingVetoes({
    route: gapRoute,
    bullish: true,
    hourlyBars: CLEAN_HOURLY_BARS,
    dailyStructure: null,
    latestDailyClose: null,
    weeklyMacdHistogramChange: null,
    rewardRiskRatio: null,
    minimumRewardRiskStrict: null,
  });
  assert.ok(result.some((v) => v.id === "gap-only-break"));
});

test("evaluateSwingVetoes: a daily close below the last Higher Low vetoes", () => {
  const result = evaluateSwingVetoes({
    route: CLEAN_ROUTE,
    bullish: true,
    hourlyBars: CLEAN_HOURLY_BARS,
    dailyStructure: CLEAN_DAILY_STRUCTURE, // lastSwingLow=120
    latestDailyClose: 115, // below it
    weeklyMacdHistogramChange: null,
    rewardRiskRatio: null,
    minimumRewardRiskStrict: null,
  });
  assert.ok(result.some((v) => v.id === "daily-structure-breach"));
});

test("evaluateSwingVetoes: the weekly MACD histogram downticking against a bullish trade vetoes", () => {
  const result = evaluateSwingVetoes({
    route: CLEAN_ROUTE,
    bullish: true,
    hourlyBars: CLEAN_HOURLY_BARS,
    dailyStructure: null,
    latestDailyClose: null,
    weeklyMacdHistogramChange: "downtick",
    rewardRiskRatio: null,
    minimumRewardRiskStrict: null,
  });
  assert.ok(result.some((v) => v.id === "weekly-macd-turn"));
});

test("evaluateSwingVetoes: reward:risk not strictly above the threshold vetoes -- exactly 3.0 fails, matching the source's own '2.6 fails, do not round up' discipline", () => {
  const result = evaluateSwingVetoes({
    route: CLEAN_ROUTE,
    bullish: true,
    hourlyBars: CLEAN_HOURLY_BARS,
    dailyStructure: null,
    latestDailyClose: null,
    weeklyMacdHistogramChange: null,
    rewardRiskRatio: 3.0,
    minimumRewardRiskStrict: 3.0,
  });
  assert.ok(result.some((v) => v.id === "reward-risk-below-threshold"));
});

test("evaluateSwingVetoes: price closing back inside the pattern within 1-2 bars of the break vetoes", () => {
  const result = evaluateSwingVetoes({
    route: CLEAN_ROUTE, // wave1@141, trigger at T0
    bullish: true,
    hourlyBars: [hbar("T0", 145), hbar("T1", 138)], // T1 closes back below wave1(141) within 1 bar
    dailyStructure: null,
    latestDailyClose: null,
    weeklyMacdHistogramChange: null,
    rewardRiskRatio: null,
    minimumRewardRiskStrict: null,
  });
  assert.ok(result.some((v) => v.id === "closed-back-inside"));
});

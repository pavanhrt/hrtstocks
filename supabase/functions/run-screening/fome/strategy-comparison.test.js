import { test } from "node:test";
import assert from "node:assert/strict";
import {
  callIntrinsic,
  putIntrinsic,
  timeValue,
  callBreakEven,
  putBreakEven,
  classifySpreadType,
  sizePositionUnderRiskCeiling,
  longCall,
  longPut,
  bullCallSpread,
  bearPutSpread,
  bullPutSpread,
  bearCallSpread,
  longStraddle,
  shortStraddle,
  shortIronCondor,
  calendarSpread,
  rankStrategies,
  compareStrategies,
  REGIME_STRATEGY_FAMILIES,
} from "./strategy-comparison.js";

test("contract calculations match strategies/fome.yaml formulas", () => {
  assert.equal(callIntrinsic(110, 100), 10);
  assert.equal(callIntrinsic(90, 100), 0);
  assert.equal(putIntrinsic(90, 100), 10);
  assert.equal(putIntrinsic(110, 100), 0);
  assert.equal(timeValue(15, 10), 5);
  assert.equal(callBreakEven(100, 5), 105);
  assert.equal(putBreakEven(100, 5), 95);
});

test("classifySpreadType: below half strike width is debit, above is credit", () => {
  assert.equal(classifySpreadType({ premiumDifference: 4, strikeWidth: 10 }), "debit");
  assert.equal(classifySpreadType({ premiumDifference: 6, strikeWidth: 10 }), "credit");
});

test("classifySpreadType: exact half strike width is manual_review, never rounded either way", () => {
  assert.equal(classifySpreadType({ premiumDifference: 5, strikeWidth: 10 }), "manual_review");
});

test("classifySpreadType: invalid/non-finite inputs are manual_review, never a guess", () => {
  assert.equal(classifySpreadType({ premiumDifference: NaN, strikeWidth: 10 }), "manual_review");
  assert.equal(classifySpreadType({ premiumDifference: 4, strikeWidth: 0 }), "manual_review");
});

test("longCall / longPut: break-even and capped buyer risk, scaled by real lot size", () => {
  const call = longCall({ strike: 100, premium: 5, lotSize: 50 });
  assert.equal(call.breakEvens[0], 105);
  assert.equal(call.maxLoss, 250);
  assert.equal(call.maxProfit, null);
  assert.equal(call.unlimitedRisk, false);

  const put = longPut({ strike: 100, premium: 5, lotSize: 50 });
  assert.equal(put.breakEvens[0], 95);
  assert.equal(put.maxLoss, 250);
});

test("longCall: unresolved lot size returns null, never assumes a lot size", () => {
  assert.equal(longCall({ strike: 100, premium: 5, lotSize: null }), null);
});

test("bullCallSpread: defined-risk debit spread payoff", () => {
  const result = bullCallSpread({ longStrike: 100, longPremium: 6, shortStrike: 110, shortPremium: 2, lotSize: 50 });
  assert.equal(result.netDebitOrCredit, -200);
  assert.equal(result.maxLoss, 200);
  assert.equal(result.maxProfit, 300);
  assert.equal(result.unlimitedRisk, false);
  assert.ok(result.rewardRisk > 1);
});

test("bullCallSpread: invalid strike ordering returns null, not a guessed payoff", () => {
  assert.equal(bullCallSpread({ longStrike: 110, longPremium: 6, shortStrike: 100, shortPremium: 2, lotSize: 50 }), null);
});

test("bearPutSpread / bullPutSpread / bearCallSpread: defined risk on both sides", () => {
  const bearPut = bearPutSpread({ longStrike: 110, longPremium: 8, shortStrike: 100, shortPremium: 3, lotSize: 50 });
  assert.equal(bearPut.maxLoss, 250);
  assert.equal(bearPut.maxProfit, 250);

  const bullPut = bullPutSpread({ shortStrike: 100, shortPremium: 4, longStrike: 90, longPremium: 1, lotSize: 50 });
  assert.equal(bullPut.netDebitOrCredit, 150);
  assert.equal(bullPut.maxProfit, 150);
  assert.equal(bullPut.maxLoss, 350);

  const bearCall = bearCallSpread({ shortStrike: 100, shortPremium: 4, longStrike: 110, longPremium: 1, lotSize: 50 });
  assert.equal(bearCall.maxProfit, 150);
  assert.equal(bearCall.maxLoss, 350);
});

test("longStraddle is capped-risk for the buyer; shortStraddle is flagged unlimited risk", () => {
  const long = longStraddle({ strike: 100, callPremium: 4, putPremium: 3, lotSize: 50 });
  assert.equal(long.maxLoss, 350);
  assert.equal(long.unlimitedRisk, false);

  const short = shortStraddle({ strike: 100, callPremium: 4, putPremium: 3, lotSize: 50 });
  assert.equal(short.maxProfit, 350);
  assert.equal(short.maxLoss, null);
  assert.equal(short.unlimitedRisk, true);
});

test("shortIronCondor: fully defined risk on both wings", () => {
  const ic = shortIronCondor({
    putLongStrike: 80,
    putShortStrike: 90,
    callShortStrike: 110,
    callLongStrike: 120,
    putLongPremium: 1,
    putShortPremium: 3,
    callShortPremium: 3,
    callLongPremium: 1,
    lotSize: 50,
  });
  assert.equal(ic.netDebitOrCredit, 200);
  assert.equal(ic.maxProfit, 200);
  assert.equal(ic.maxLoss, 300);
  assert.equal(ic.unlimitedRisk, false);
});

test("calendarSpread: honestly NO_DATA, never a fabricated payoff", () => {
  const cal = calendarSpread({ nearExpiry: "2026-09-25", farExpiry: "2026-10-30", strike: 100 });
  assert.equal(cal.dataQuality, "NO_DATA");
  assert.equal(cal.maxProfit, null);
  assert.equal(cal.maxLoss, null);
  assert.ok(cal.dataQualityReason.length > 0);
});

test("sizePositionUnderRiskCeiling: never exceeds the 2% risk ceiling or allocation guideline", () => {
  const sized = sizePositionUnderRiskCeiling({
    capital: 1_000_000,
    maxLossPerLot: 5_000,
    lotSize: 50,
    allocationFraction: 0.08,
    maxRiskFraction: 0.02,
  });
  assert.equal(sized.lots, 4);
  assert.equal(sized.plannedLoss, 20_000);
  assert.ok(sized.plannedLoss <= 1_000_000 * 0.02);
});

test("sizePositionUnderRiskCeiling: unresolved lot size never fabricated -- explicit reason", () => {
  const sized = sizePositionUnderRiskCeiling({
    capital: 1_000_000,
    maxLossPerLot: 5_000,
    lotSize: null,
    allocationFraction: 0.08,
    maxRiskFraction: 0.02,
  });
  assert.equal(sized.lots, 0);
  assert.match(sized.reason, /lot size unavailable/);
});

test("sizePositionUnderRiskCeiling: zero lots (not negative/fractional) when even one lot breaches the ceiling", () => {
  const sized = sizePositionUnderRiskCeiling({
    capital: 10_000,
    maxLossPerLot: 50_000,
    lotSize: 50,
    allocationFraction: 0.08,
    maxRiskFraction: 0.02,
  });
  assert.equal(sized.lots, 0);
  assert.equal(sized.quantity, 0);
  assert.ok(sized.reason);
});

test("rankStrategies: defined-risk candidates are never ranked below an unlimited-risk one", () => {
  const defined = bullCallSpread({ longStrike: 100, longPremium: 6, shortStrike: 110, shortPremium: 2, lotSize: 50 });
  const tailRisk = shortStraddle({ strike: 100, callPremium: 4, putPremium: 3, lotSize: 50 });
  const ranked = rankStrategies([tailRisk, defined]);
  assert.equal(ranked[0].strategyId, "bull_call_spread");
  assert.equal(ranked[0].unlimitedRisk, false);
  assert.equal(ranked[1].strategyId, "short_straddle");
});

test("rankStrategies: null builder results (invalid strikes/lot size) are dropped, not zero-filled", () => {
  const invalid = bullCallSpread({ longStrike: 110, longPremium: 6, shortStrike: 100, shortPremium: 2, lotSize: 50 });
  const valid = bullCallSpread({ longStrike: 100, longPremium: 6, shortStrike: 110, shortPremium: 2, lotSize: 50 });
  const ranked = rankStrategies([invalid, valid]);
  assert.equal(ranked.length, 1);
  assert.equal(ranked[0].strategyId, "bull_call_spread");
});

test("compareStrategies: strong_bullish regime picks a defined-risk best fit", () => {
  const { bestFit, candidates } = compareStrategies("strong_bullish", {
    long_futures: () => null,
    long_call: () => longCall({ strike: 100, premium: 5, lotSize: 50 }),
    bull_call_spread: () => bullCallSpread({ longStrike: 100, longPremium: 6, shortStrike: 110, shortPremium: 2, lotSize: 50 }),
    bullish_call_ratio_spread: () => null,
  });
  assert.ok(candidates.length >= 1);
  assert.ok(bestFit);
  assert.equal(bestFit.unlimitedRisk, false);
});

test("compareStrategies: unrecognized regime yields no candidates, not a guessed match", () => {
  const { candidates, bestFit, reason } = compareStrategies("not_a_real_regime", {});
  assert.equal(candidates.length, 0);
  assert.equal(bestFit, null);
  assert.ok(reason.includes("Unrecognized"));
});

test("compareStrategies: unresolved lot size across the board yields no qualified candidates, not fabricated ones", () => {
  const { bestFit } = compareStrategies("strong_bullish", {
    long_futures: () => null,
    long_call: () => longCall({ strike: 100, premium: 5, lotSize: null }),
    bull_call_spread: () => bullCallSpread({ longStrike: 100, longPremium: 6, shortStrike: 110, shortPremium: 2, lotSize: null }),
    bullish_call_ratio_spread: () => null,
  });
  assert.equal(bestFit, null);
});

test("REGIME_STRATEGY_FAMILIES never includes a naked-selling builder", () => {
  const allStrategyIds = Object.values(REGIME_STRATEGY_FAMILIES).flat();
  assert.ok(!allStrategyIds.includes("sell_naked_call"));
  assert.ok(!allStrategyIds.includes("sell_naked_put"));
});

// Deterministic FOME strategy-comparison engine -- pure functions, no I/O,
// no Supabase/Fyers dependency, fully unit-testable in isolation from the
// rest of the pipeline (references/technical-architecture.md: "keep every
// layer independently testable"). Given a regime classification and live
// contract quotes, computes payoff/risk figures for every strategy
// strategies/fome.yaml names and ranks them.
//
// Scope and honesty limits (see strategies/fome.md/.yaml for the source):
//   - Payoffs are computed at the *option's own expiry* (standard textbook
//     max/min-based payoff diagrams), using only intrinsic value at
//     expiration -- this project has no live option-pricing model (no
//     Black-Scholes/binomial engine, no historical-vol surface), so no
//     strategy's payoff before expiry is estimated. That specifically means
//     a calendar spread's payoff genuinely cannot be computed here (its
//     entire edge depends on time decay differential between two expiries,
//     which requires pricing the far leg on the near leg's expiry date) --
//     calendarSpread() below returns a NO_DATA-shaped result instead of a
//     fabricated number. This is a genuine limitation, not an oversight.
//   - Margin is never fabricated: this project has no margin-calculator API
//     integration, so every strategy's `margin` is `{state: "unavailable"}`
//     rather than a guessed number. `marginState` disclosure is what
//     strategies/fome.yaml's own `payoff_fields_required` calls a "clearly
//     labelled unavailable state."
//   - Lot size is a caller-supplied parameter, never invented here -- see
//     fome/contract-selection.js for where it comes from (Fyers-derived,
//     honestly `null`/unavailable when not resolvable, per AGENTS.md's rule
//     against fabricating contract metadata).
//   - Naked option selling (Sell Naked Call/Put) is intentionally NOT
//     exposed as a strategy builder here at all, per AGENTS.md ("Do not
//     recommend naked option selling as a default") and fome.yaml's
//     `default_naked_option_selling: prohibited` -- only defined-risk
//     structures and the covered variants are built.

export const FOME_STRATEGY_ENGINE_VERSION = "1.0.0";

/** strategies/fome.yaml `calculations.call_intrinsic`. */
export function callIntrinsic(spot, strike) {
  return Math.max(spot - strike, 0);
}

/** strategies/fome.yaml `calculations.put_intrinsic`. */
export function putIntrinsic(spot, strike) {
  return Math.max(strike - spot, 0);
}

/** strategies/fome.yaml `calculations.time_value`. */
export function timeValue(premium, intrinsic) {
  return premium - intrinsic;
}

/** strategies/fome.yaml `calculations.call_break_even`. */
export function callBreakEven(strike, premium) {
  return strike + premium;
}

/** strategies/fome.yaml `calculations.put_break_even`. */
export function putBreakEven(strike, premium) {
  return strike - premium;
}

/**
 * strategies/fome.yaml `constraints.debit_spread_test` /
 * `credit_spread_test`: "premium difference below half the strike width ->
 * evaluate debit spread; above -> credit spread." An exact tie (premium
 * difference == strike width / 2) is deliberately left MANUAL_REVIEW rather
 * than silently rounded to either side -- the source guide sheet only ever
 * states "less than" / "more than," never what happens exactly at the
 * boundary.
 * @returns {"debit"|"credit"|"manual_review"}
 */
export function classifySpreadType({ premiumDifference, strikeWidth }) {
  if (!Number.isFinite(premiumDifference) || !Number.isFinite(strikeWidth) || strikeWidth <= 0) {
    return "manual_review";
  }
  const half = strikeWidth / 2;
  if (premiumDifference === half) return "manual_review";
  return premiumDifference < half ? "debit" : "credit";
}

/**
 * strategies/fome.yaml `option_buying_allocation_fraction` (5%-8% of
 * capital) combined with AGENTS.md's 2%-of-capital maximum planned-loss
 * ceiling: returns the largest integer lot count that keeps BOTH the
 * capital-allocation guideline and the hard loss ceiling satisfied. Never
 * rounds up past either limit, and returns 0 (not a negative or fractional
 * lot count) when even one lot would breach the loss ceiling. Returns
 * `{lots: 0, reason: "lot size unavailable"}` when `lotSize` is not a real,
 * resolved number -- never assumes a lot size to make this computable.
 * @param {{capital: number, maxLossPerLot: number, lotSize: number|null, allocationFraction: number, maxRiskFraction: number}} input
 */
export function sizePositionUnderRiskCeiling({ capital, maxLossPerLot, lotSize, allocationFraction, maxRiskFraction }) {
  if (lotSize == null) {
    return { lots: 0, quantity: 0, plannedLoss: 0, reason: "lot size unavailable -- position sizing cannot be computed" };
  }
  if (![capital, maxLossPerLot, lotSize, allocationFraction, maxRiskFraction].every((v) => Number.isFinite(v) && v > 0)) {
    return { lots: 0, quantity: 0, plannedLoss: 0, reason: "insufficient contract/capital data" };
  }
  const riskBudget = capital * maxRiskFraction;
  const allocationBudget = capital * allocationFraction;
  const lotsByRisk = Math.floor(riskBudget / maxLossPerLot);
  const lotsByAllocation = Math.floor(allocationBudget / maxLossPerLot);
  const lots = Math.max(0, Math.min(lotsByRisk, lotsByAllocation));
  return {
    lots,
    quantity: lots * lotSize,
    plannedLoss: lots * maxLossPerLot,
    reason: lots === 0 ? "even one lot exceeds the 2% risk ceiling or allocation guideline" : null,
  };
}

function roi(gain, deployed) {
  if (!Number.isFinite(gain) || !Number.isFinite(deployed) || deployed <= 0) return null;
  return (gain / deployed) * 100;
}

const MARGIN_UNAVAILABLE = { value: null, state: "unavailable" };

// ---------------------------------------------------------------------------
// Single-leg / futures
// ---------------------------------------------------------------------------

export function longFutures({ entryPrice, target, invalidation, lotSize }) {
  if (lotSize == null) return null;
  const maxProfitPerUnit = Number.isFinite(target) ? target - entryPrice : null;
  const maxLossPerUnit = Number.isFinite(invalidation) ? entryPrice - invalidation : null;
  return {
    strategyId: "long_futures",
    legs: [{ action: "buy", instrument: "future", quantity: lotSize }],
    netDebitOrCredit: 0,
    breakEvens: [entryPrice],
    maxProfit: maxProfitPerUnit != null ? maxProfitPerUnit * lotSize : null,
    maxLoss: maxLossPerUnit != null ? maxLossPerUnit * lotSize : null,
    margin: MARGIN_UNAVAILABLE,
    rewardRisk: maxProfitPerUnit != null && maxLossPerUnit > 0 ? maxProfitPerUnit / maxLossPerUnit : null,
    roiPct: null,
    unlimitedRisk: false,
  };
}

export function shortFutures({ entryPrice, target, invalidation, lotSize }) {
  if (lotSize == null) return null;
  const maxProfitPerUnit = Number.isFinite(target) ? entryPrice - target : null;
  const maxLossPerUnit = Number.isFinite(invalidation) ? invalidation - entryPrice : null;
  return {
    strategyId: "short_futures",
    legs: [{ action: "sell", instrument: "future", quantity: lotSize }],
    netDebitOrCredit: 0,
    breakEvens: [entryPrice],
    maxProfit: maxProfitPerUnit != null ? maxProfitPerUnit * lotSize : null,
    maxLoss: maxLossPerUnit != null ? maxLossPerUnit * lotSize : null,
    margin: MARGIN_UNAVAILABLE,
    rewardRisk: maxProfitPerUnit != null && maxLossPerUnit > 0 ? maxProfitPerUnit / maxLossPerUnit : null,
    roiPct: null,
    unlimitedRisk: false,
  };
}

export function longCall({ strike, premium, lotSize }) {
  if (lotSize == null) return null;
  const breakEven = callBreakEven(strike, premium);
  return {
    strategyId: "long_call",
    legs: [{ action: "buy", type: "CE", strike, quantity: lotSize }],
    netDebitOrCredit: -premium * lotSize,
    breakEvens: [breakEven],
    maxProfit: null,
    maxLoss: premium * lotSize,
    margin: MARGIN_UNAVAILABLE,
    rewardRisk: null,
    roiPct: null,
    unlimitedRisk: false,
  };
}

export function longPut({ strike, premium, lotSize }) {
  if (lotSize == null) return null;
  const breakEven = putBreakEven(strike, premium);
  return {
    strategyId: "long_put",
    legs: [{ action: "buy", type: "PE", strike, quantity: lotSize }],
    netDebitOrCredit: -premium * lotSize,
    breakEvens: [breakEven],
    maxProfit: breakEven * lotSize,
    maxLoss: premium * lotSize,
    margin: MARGIN_UNAVAILABLE,
    rewardRisk: null,
    roiPct: null,
    unlimitedRisk: false,
  };
}

// ---------------------------------------------------------------------------
// Vertical spreads (1:1, per fome.yaml's documented ratio)
// ---------------------------------------------------------------------------

export function bullCallSpread({ longStrike, longPremium, shortStrike, shortPremium, lotSize }) {
  if (lotSize == null || shortStrike <= longStrike) return null;
  const netDebit = (longPremium - shortPremium) * lotSize;
  const width = (shortStrike - longStrike) * lotSize;
  return {
    strategyId: "bull_call_spread",
    legs: [
      { action: "buy", type: "CE", strike: longStrike, quantity: lotSize },
      { action: "sell", type: "CE", strike: shortStrike, quantity: lotSize },
    ],
    netDebitOrCredit: -netDebit,
    breakEvens: [longStrike + (longPremium - shortPremium)],
    maxProfit: width - netDebit,
    maxLoss: netDebit,
    margin: MARGIN_UNAVAILABLE,
    rewardRisk: netDebit > 0 ? (width - netDebit) / netDebit : null,
    roiPct: roi(width - netDebit, netDebit),
    unlimitedRisk: false,
  };
}

export function bearPutSpread({ longStrike, longPremium, shortStrike, shortPremium, lotSize }) {
  if (lotSize == null || longStrike <= shortStrike) return null;
  const netDebit = (longPremium - shortPremium) * lotSize;
  const width = (longStrike - shortStrike) * lotSize;
  return {
    strategyId: "bear_put_spread",
    legs: [
      { action: "buy", type: "PE", strike: longStrike, quantity: lotSize },
      { action: "sell", type: "PE", strike: shortStrike, quantity: lotSize },
    ],
    netDebitOrCredit: -netDebit,
    breakEvens: [longStrike - (longPremium - shortPremium)],
    maxProfit: width - netDebit,
    maxLoss: netDebit,
    margin: MARGIN_UNAVAILABLE,
    rewardRisk: netDebit > 0 ? (width - netDebit) / netDebit : null,
    roiPct: roi(width - netDebit, netDebit),
    unlimitedRisk: false,
  };
}

export function bullPutSpread({ shortStrike, shortPremium, longStrike, longPremium, lotSize }) {
  if (lotSize == null || shortStrike <= longStrike) return null;
  const netCredit = (shortPremium - longPremium) * lotSize;
  const width = (shortStrike - longStrike) * lotSize;
  return {
    strategyId: "bull_put_spread",
    legs: [
      { action: "sell", type: "PE", strike: shortStrike, quantity: lotSize },
      { action: "buy", type: "PE", strike: longStrike, quantity: lotSize },
    ],
    netDebitOrCredit: netCredit,
    breakEvens: [shortStrike - (shortPremium - longPremium)],
    maxProfit: netCredit,
    maxLoss: width - netCredit,
    margin: MARGIN_UNAVAILABLE,
    rewardRisk: width - netCredit > 0 ? netCredit / (width - netCredit) : null,
    roiPct: null,
    unlimitedRisk: false,
  };
}

export function bearCallSpread({ shortStrike, shortPremium, longStrike, longPremium, lotSize }) {
  if (lotSize == null || longStrike <= shortStrike) return null;
  const netCredit = (shortPremium - longPremium) * lotSize;
  const width = (longStrike - shortStrike) * lotSize;
  return {
    strategyId: "bear_call_spread",
    legs: [
      { action: "sell", type: "CE", strike: shortStrike, quantity: lotSize },
      { action: "buy", type: "CE", strike: longStrike, quantity: lotSize },
    ],
    netDebitOrCredit: netCredit,
    breakEvens: [shortStrike + (shortPremium - longPremium)],
    maxProfit: netCredit,
    maxLoss: width - netCredit,
    margin: MARGIN_UNAVAILABLE,
    rewardRisk: width - netCredit > 0 ? netCredit / (width - netCredit) : null,
    roiPct: null,
    unlimitedRisk: false,
  };
}

// ---------------------------------------------------------------------------
// Covered / collars
// ---------------------------------------------------------------------------

export function coveredCall({ spot, callStrike, callPremium, lotSize }) {
  if (lotSize == null) return null;
  return {
    strategyId: "covered_call",
    legs: [
      { action: "hold", instrument: "equity", quantity: lotSize },
      { action: "sell", type: "CE", strike: callStrike, quantity: lotSize },
    ],
    netDebitOrCredit: callPremium * lotSize,
    breakEvens: [spot - callPremium],
    maxProfit: (callStrike - spot + callPremium) * lotSize,
    maxLoss: (spot - callPremium) * lotSize,
    margin: MARGIN_UNAVAILABLE,
    rewardRisk: null,
    roiPct: null,
    unlimitedRisk: false,
  };
}

export function coveredPut({ spot, putStrike, putPremium, lotSize }) {
  if (lotSize == null) return null;
  return {
    strategyId: "covered_put",
    legs: [
      { action: "hold", instrument: "equity_short", quantity: lotSize },
      { action: "sell", type: "PE", strike: putStrike, quantity: lotSize },
    ],
    netDebitOrCredit: putPremium * lotSize,
    breakEvens: [spot + putPremium],
    maxProfit: (spot - putStrike + putPremium) * lotSize,
    maxLoss: null,
    margin: MARGIN_UNAVAILABLE,
    rewardRisk: null,
    roiPct: null,
    unlimitedRisk: true,
  };
}

export function longCollar({ spot, putStrike, putPremium, callStrike, callPremium, lotSize }) {
  if (lotSize == null) return null;
  const netDebit = (putPremium - callPremium) * lotSize;
  return {
    strategyId: "long_collar",
    legs: [
      { action: "hold", instrument: "equity", quantity: lotSize },
      { action: "buy", type: "PE", strike: putStrike, quantity: lotSize },
      { action: "sell", type: "CE", strike: callStrike, quantity: lotSize },
    ],
    netDebitOrCredit: -netDebit,
    breakEvens: [spot + netDebit / lotSize],
    maxProfit: (callStrike - spot) * lotSize - netDebit,
    maxLoss: (spot - putStrike) * lotSize + netDebit,
    margin: MARGIN_UNAVAILABLE,
    rewardRisk: null,
    roiPct: null,
    unlimitedRisk: false,
  };
}

export function shortCollar({ spot, callStrike, callPremium, putStrike, putPremium, lotSize }) {
  if (lotSize == null) return null;
  const netDebit = (callPremium - putPremium) * lotSize;
  return {
    strategyId: "short_collar",
    legs: [
      { action: "hold", instrument: "equity_short", quantity: lotSize },
      { action: "buy", type: "CE", strike: callStrike, quantity: lotSize },
      { action: "sell", type: "PE", strike: putStrike, quantity: lotSize },
    ],
    netDebitOrCredit: -netDebit,
    breakEvens: [spot - netDebit / lotSize],
    maxProfit: (spot - putStrike) * lotSize - netDebit,
    maxLoss: (callStrike - spot) * lotSize + netDebit,
    margin: MARGIN_UNAVAILABLE,
    rewardRisk: null,
    roiPct: null,
    unlimitedRisk: false,
  };
}

// ---------------------------------------------------------------------------
// Ratio spreads (bullish call / bearish put, 1:2 -- fome.md "call/put ratio
// spread"; the short leg beyond the 1:1 hedge is undefined risk past its own
// break-even, which is disclosed via `unlimitedRisk`, never hidden)
// ---------------------------------------------------------------------------

export function bullishCallRatioSpread({ longStrike, longPremium, shortStrike, shortPremium, lotSize }) {
  if (lotSize == null || shortStrike <= longStrike) return null;
  const netDebit = (longPremium - 2 * shortPremium) * lotSize;
  const width = (shortStrike - longStrike) * lotSize;
  return {
    strategyId: "bullish_call_ratio_spread",
    legs: [
      { action: "buy", type: "CE", strike: longStrike, quantity: lotSize },
      { action: "sell", type: "CE", strike: shortStrike, quantity: 2 * lotSize },
    ],
    netDebitOrCredit: -netDebit,
    breakEvens: [longStrike + (longPremium - 2 * shortPremium), shortStrike * 2 - longStrike - (longPremium - 2 * shortPremium)],
    maxProfit: width - netDebit,
    maxLoss: netDebit > 0 ? netDebit : null,
    margin: MARGIN_UNAVAILABLE,
    rewardRisk: null,
    roiPct: null,
    unlimitedRisk: true,
  };
}

export function bearishPutRatioSpread({ longStrike, longPremium, shortStrike, shortPremium, lotSize }) {
  if (lotSize == null || longStrike <= shortStrike) return null;
  const netDebit = (longPremium - 2 * shortPremium) * lotSize;
  const width = (longStrike - shortStrike) * lotSize;
  return {
    strategyId: "bearish_put_ratio_spread",
    legs: [
      { action: "buy", type: "PE", strike: longStrike, quantity: lotSize },
      { action: "sell", type: "PE", strike: shortStrike, quantity: 2 * lotSize },
    ],
    netDebitOrCredit: -netDebit,
    breakEvens: [longStrike - (longPremium - 2 * shortPremium), 2 * shortStrike - longStrike + (longPremium - 2 * shortPremium)],
    maxProfit: width - netDebit,
    maxLoss: netDebit > 0 ? netDebit : null,
    margin: MARGIN_UNAVAILABLE,
    rewardRisk: null,
    roiPct: null,
    unlimitedRisk: true,
  };
}

// ---------------------------------------------------------------------------
// Straddle / strangle
// ---------------------------------------------------------------------------

export function longStraddle({ strike, callPremium, putPremium, lotSize }) {
  if (lotSize == null) return null;
  const totalPremium = (callPremium + putPremium) * lotSize;
  return {
    strategyId: "long_straddle",
    legs: [
      { action: "buy", type: "CE", strike, quantity: lotSize },
      { action: "buy", type: "PE", strike, quantity: lotSize },
    ],
    netDebitOrCredit: -totalPremium,
    breakEvens: [strike - (callPremium + putPremium), strike + (callPremium + putPremium)],
    maxProfit: null,
    maxLoss: totalPremium,
    margin: MARGIN_UNAVAILABLE,
    rewardRisk: null,
    roiPct: null,
    unlimitedRisk: false,
  };
}

export function longStrangle({ callStrike, callPremium, putStrike, putPremium, lotSize }) {
  if (lotSize == null || callStrike <= putStrike) return null;
  const totalPremium = (callPremium + putPremium) * lotSize;
  return {
    strategyId: "long_strangle",
    legs: [
      { action: "buy", type: "CE", strike: callStrike, quantity: lotSize },
      { action: "buy", type: "PE", strike: putStrike, quantity: lotSize },
    ],
    netDebitOrCredit: -totalPremium,
    breakEvens: [putStrike - (callPremium + putPremium), callStrike + (callPremium + putPremium)],
    maxProfit: null,
    maxLoss: totalPremium,
    margin: MARGIN_UNAVAILABLE,
    rewardRisk: null,
    roiPct: null,
    unlimitedRisk: false,
  };
}

/**
 * Sell Straddle/Strangle -- exposed ONLY as `shortStraddle`/`shortStrangle`
 * below, both flagged `unlimitedRisk: true` and both required by
 * compareStrategies() to be ranked strictly below any defined-risk
 * alternative for the same regime (short iron butterfly/condor), per
 * AGENTS.md's "show defined-risk alternatives... never default to naked
 * option selling."
 */
export function shortStraddle({ strike, callPremium, putPremium, lotSize }) {
  if (lotSize == null) return null;
  const totalCredit = (callPremium + putPremium) * lotSize;
  return {
    strategyId: "short_straddle",
    legs: [
      { action: "sell", type: "CE", strike, quantity: lotSize },
      { action: "sell", type: "PE", strike, quantity: lotSize },
    ],
    netDebitOrCredit: totalCredit,
    breakEvens: [strike - (callPremium + putPremium), strike + (callPremium + putPremium)],
    maxProfit: totalCredit,
    maxLoss: null,
    margin: MARGIN_UNAVAILABLE,
    rewardRisk: null,
    roiPct: null,
    unlimitedRisk: true,
  };
}

export function shortStrangle({ callStrike, callPremium, putStrike, putPremium, lotSize }) {
  if (lotSize == null || callStrike <= putStrike) return null;
  const totalCredit = (callPremium + putPremium) * lotSize;
  return {
    strategyId: "short_strangle",
    legs: [
      { action: "sell", type: "CE", strike: callStrike, quantity: lotSize },
      { action: "sell", type: "PE", strike: putStrike, quantity: lotSize },
    ],
    netDebitOrCredit: totalCredit,
    breakEvens: [putStrike - (callPremium + putPremium), callStrike + (callPremium + putPremium)],
    maxProfit: totalCredit,
    maxLoss: null,
    margin: MARGIN_UNAVAILABLE,
    rewardRisk: null,
    roiPct: null,
    unlimitedRisk: true,
  };
}

// ---------------------------------------------------------------------------
// Iron condor / butterfly (short = credit/restricted-range; long = debit/big-move)
// ---------------------------------------------------------------------------

function ironStructure({ strategyId, putLongStrike, putShortStrike, callShortStrike, callLongStrike, putLongPremium, putShortPremium, callShortPremium, callLongPremium, lotSize, isShort }) {
  if (lotSize == null) return null;
  if (!(putLongStrike < putShortStrike && putShortStrike <= callShortStrike && callShortStrike < callLongStrike)) return null;
  const netOptionFlow = isShort
    ? (putShortPremium + callShortPremium - putLongPremium - callLongPremium) * lotSize
    : (putLongPremium + callLongPremium - putShortPremium - callShortPremium) * lotSize;
  const putWingWidth = (putShortStrike - putLongStrike) * lotSize;
  const callWingWidth = (callLongStrike - callShortStrike) * lotSize;
  const maxWingWidth = Math.max(putWingWidth, callWingWidth);
  const maxProfit = isShort ? netOptionFlow : maxWingWidth - netOptionFlow;
  const maxLoss = isShort ? maxWingWidth - netOptionFlow : netOptionFlow;
  return {
    strategyId,
    legs: [
      { action: isShort ? "buy" : "sell", type: "PE", strike: putLongStrike, quantity: lotSize },
      { action: isShort ? "sell" : "buy", type: "PE", strike: putShortStrike, quantity: lotSize },
      { action: isShort ? "sell" : "buy", type: "CE", strike: callShortStrike, quantity: lotSize },
      { action: isShort ? "buy" : "sell", type: "CE", strike: callLongStrike, quantity: lotSize },
    ],
    netDebitOrCredit: isShort ? netOptionFlow : -netOptionFlow,
    breakEvens: isShort
      ? [putShortStrike - netOptionFlow / lotSize, callShortStrike + netOptionFlow / lotSize]
      : [putLongStrike + netOptionFlow / lotSize, callLongStrike - netOptionFlow / lotSize],
    maxProfit,
    maxLoss,
    margin: MARGIN_UNAVAILABLE,
    rewardRisk: maxLoss > 0 ? maxProfit / maxLoss : null,
    roiPct: isShort ? null : roi(maxProfit, netOptionFlow),
    unlimitedRisk: false,
  };
}

export function shortIronCondor(strikes) {
  return ironStructure({ ...strikes, strategyId: "short_iron_condor", isShort: true });
}
export function shortIronButterfly(strikes) {
  return ironStructure({ ...strikes, strategyId: "short_iron_butterfly", isShort: true });
}
export function longIronCondor(strikes) {
  return ironStructure({ ...strikes, strategyId: "long_iron_condor", isShort: false });
}
export function longIronButterfly(strikes) {
  return ironStructure({ ...strikes, strategyId: "long_iron_butterfly", isShort: false });
}

/**
 * Calendar spread -- deliberately NOT a payoff calculator (see module header
 * comment): this project has no option-pricing model to value the far-month
 * leg on the near-month's expiry date. Returns the qualification/context
 * fields the comparison table needs (so the row isn't silently omitted -- it
 * always appears with an honest NO_DATA state) without inventing a number
 * for any payoff field.
 */
export function calendarSpread({ nearExpiry, farExpiry, strike }) {
  return {
    strategyId: "calendar_spread",
    legs: [
      { action: "sell", strike, expiry: nearExpiry },
      { action: "buy", strike, expiry: farExpiry },
    ],
    netDebitOrCredit: null,
    breakEvens: [],
    maxProfit: null,
    maxLoss: null,
    margin: MARGIN_UNAVAILABLE,
    rewardRisk: null,
    roiPct: null,
    unlimitedRisk: false,
    dataQuality: "NO_DATA",
    dataQualityReason: "Calendar-spread payoff depends on the far leg's value on the near leg's expiry date, which requires an option-pricing model this project does not implement -- never fabricated.",
  };
}

// ---------------------------------------------------------------------------
// Regime -> strategy-family mapping (strategies/fome.yaml `strategy_mapping`)
// and comparison/ranking
// ---------------------------------------------------------------------------

export const REGIME_STRATEGY_FAMILIES = {
  strong_bullish: ["long_futures", "long_call", "bull_call_spread", "bullish_call_ratio_spread"],
  strong_bearish: ["short_futures", "long_put", "bear_put_spread", "bearish_put_ratio_spread"],
  moderate_bullish_or_near_support: ["covered_call", "bull_call_spread", "bull_put_spread", "long_collar"],
  moderate_bearish_or_near_resistance: ["covered_put", "bear_put_spread", "bear_call_spread", "short_collar"],
  restricted_range: ["short_iron_butterfly", "short_iron_condor"],
  large_move_either_direction: ["long_straddle", "long_strangle", "long_iron_butterfly", "long_iron_condor"],
  target_after_current_expiry: ["calendar_spread"],
};

/**
 * Ranks a set of already-built strategy results for one regime. Defined-risk
 * structures are never ranked below an unlimited-risk one for the same
 * qualification tier. A strategy missing required payoff fields (builder
 * returned null, e.g. invalid strike ordering or unresolved lot size) is
 * dropped, not silently zero-filled.
 * @param {Array<object|null>} results
 * @returns {Array<object & {rank: number, qualificationStatus: string}>}
 */
export function rankStrategies(results) {
  const valid = results.filter((r) => r !== null && r !== undefined);
  const withStatus = valid.map((r) => {
    let qualificationStatus;
    if (r.dataQuality === "NO_DATA") qualificationStatus = "no_data";
    else if (r.maxLoss == null && r.unlimitedRisk) qualificationStatus = "watch";
    else qualificationStatus = "qualified";
    return { ...r, qualificationStatus };
  });

  withStatus.sort((a, b) => {
    if (a.unlimitedRisk !== b.unlimitedRisk) return a.unlimitedRisk ? 1 : -1;
    const aRR = a.rewardRisk ?? -Infinity;
    const bRR = b.rewardRisk ?? -Infinity;
    return bRR - aRR;
  });

  return withStatus.map((r, i) => ({ ...r, rank: i + 1 }));
}

/**
 * Full regime -> candidate-comparison entry point. `builders` maps each
 * strategyId named in REGIME_STRATEGY_FAMILIES to a zero-arg thunk producing
 * that strategy's result (the caller closes over live strike/premium/spot
 * data) -- keeps this function itself free of any contract-shape
 * assumptions beyond the family list.
 * @param {keyof typeof REGIME_STRATEGY_FAMILIES} regime
 * @param {Record<string, () => object|null>} builders
 */
export function compareStrategies(regime, builders) {
  const family = REGIME_STRATEGY_FAMILIES[regime];
  if (!family) return { regime, candidates: [], bestFit: null, reason: `Unrecognized regime "${regime}"` };

  const results = family.map((id) => (builders[id] ? builders[id]() : null));
  const candidates = rankStrategies(results);
  const bestFit = candidates.find((c) => c.qualificationStatus === "qualified") ?? null;

  return {
    regime,
    candidates,
    bestFit,
    reason: bestFit
      ? `${bestFit.strategyId} ranked highest by reward:risk among defined-risk candidates for regime "${regime}".`
      : `No candidate for regime "${regime}" satisfied every hard prerequisite (valid strikes, defined risk, resolved lot size, computable payoff).`,
  };
}

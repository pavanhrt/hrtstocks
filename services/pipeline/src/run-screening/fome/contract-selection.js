// Deterministic, pure contract-selection and provenance logic for FOME's
// derivative overlay. No I/O -- the Edge Function supplies already-fetched
// provider data; this module only picks/validates/labels it. Every function
// here exists specifically so a missing or ambiguous piece of contract
// metadata degrades to an honest NO_DATA/CONFLICT state instead of an
// invented value (AGENTS.md: "never invent, interpolate, or silently repair
// market data").

export const CONTRACT_SELECTION_VERSION = "1.0.0";

// PROJECT_DEFAULT, disclosed: no FOME source document specifies how stale a
// spot/derivative pairing may be before it's unusable. AGENTS.md's own
// market-data-policy language ("never combine spot and derivative snapshots
// with materially mismatched timestamps without warning") requires SOME
// threshold; this picks 5 minutes as a conservative bound for live intraday
// quotes (well under one 15-minute candle), not extracted from any FOME
// guide sheet.
export const MAX_SPOT_DERIVATIVE_SKEW_MS = 5 * 60 * 1000;

/**
 * "If multiple expiries exist, select according to a documented rule and
 * show alternatives" -- the documented rule here is simply "nearest
 * (soonest) unexpired expiry," the standard convention this project's own
 * fome.yaml assumes throughout (it never names a rollover rule of its own).
 * Returns null (not the first array entry blindly) when no expiry is in the
 * future relative to `asOf`.
 * @param {{date: string, expiryEpoch: string|number}[]} expiries
 * @param {Date} asOf
 * @returns {{selected: object|null, alternatives: object[]}}
 */
export function selectNearestExpiry(expiries, asOf) {
  const asOfMs = asOf.getTime();
  const future = (expiries ?? [])
    .filter((e) => Number.isFinite(Number(e.expiryEpoch)) && Number(e.expiryEpoch) * 1000 > asOfMs)
    .sort((a, b) => Number(a.expiryEpoch) - Number(b.expiryEpoch));
  if (future.length === 0) return { selected: null, alternatives: [] };
  return { selected: future[0], alternatives: future.slice(1) };
}

/**
 * Selects the ATM, one documented step ITM, and one documented step OTM
 * contract from an already-fetched, already-strike-sorted contract list for
 * one option type. "ATM" = the contract whose strike is closest to spot (a
 * tie is resolved toward the LOWER strike, a disclosed, deterministic
 * PROJECT_DEFAULT -- no source document specifies tie-breaking). ITM/OTM
 * direction along the sorted ladder is the OPPOSITE for calls and puts (a
 * call is ITM below spot; a put is ITM above spot) -- `optionType` selects
 * which side of the ladder each label reads from, so this never silently
 * mislabels a put's ITM leg as OTM or vice versa. Returns null for any leg
 * that doesn't exist in the supplied list -- never fabricates a strike that
 * wasn't actually quoted.
 * @param {{strike: number}[]} sortedContracts ascending by strike, one option type only
 * @param {number} spot
 * @param {"CE"|"PE"} optionType
 * @returns {{atm: object|null, itm: object|null, otm: object|null}}
 */
export function selectStrikeLadder(sortedContracts, spot, optionType) {
  if (!sortedContracts || sortedContracts.length === 0) return { atm: null, itm: null, otm: null };
  let atmIndex = 0;
  let bestDistance = Infinity;
  for (let i = 0; i < sortedContracts.length; i++) {
    const distance = Math.abs(sortedContracts[i].strike - spot);
    if (distance < bestDistance || (distance === bestDistance && sortedContracts[i].strike < sortedContracts[atmIndex].strike)) {
      bestDistance = distance;
      atmIndex = i;
    }
  }
  const atm = sortedContracts[atmIndex];
  const lowerNeighbor = sortedContracts[atmIndex - 1] ?? null; // lower strike
  const upperNeighbor = sortedContracts[atmIndex + 1] ?? null; // higher strike
  const isCall = optionType === "CE";
  return {
    atm,
    itm: isCall ? lowerNeighbor : upperNeighbor,
    otm: isCall ? upperNeighbor : lowerNeighbor,
  };
}

/**
 * "Ensure selected spot and derivative timestamps are aligned" /
 * AGENTS.md's "never combine spot and derivative snapshots with materially
 * mismatched timestamps without warning" -- made mechanical. Returns
 * `{aligned: true}` only when both timestamps parse and the gap is within
 * MAX_SPOT_DERIVATIVE_SKEW_MS; otherwise `{aligned: false, reason}`, which
 * callers must treat as a hard block on any contract-level qualification
 * (never a soft warning that still lets a recommendation through).
 * @param {string|Date|null} spotTimestamp
 * @param {string|Date|null} derivativeTimestamp
 */
export function checkSpotDerivativeAlignment(spotTimestamp, derivativeTimestamp) {
  if (!spotTimestamp || !derivativeTimestamp) {
    return { aligned: false, reason: "spot or derivative timestamp is missing" };
  }
  const spotMs = new Date(spotTimestamp).getTime();
  const derivMs = new Date(derivativeTimestamp).getTime();
  if (!Number.isFinite(spotMs) || !Number.isFinite(derivMs)) {
    return { aligned: false, reason: "spot or derivative timestamp is invalid" };
  }
  const skewMs = Math.abs(spotMs - derivMs);
  if (skewMs > MAX_SPOT_DERIVATIVE_SKEW_MS) {
    return { aligned: false, reason: `spot/derivative timestamps differ by ${Math.round(skewMs / 1000)}s, exceeding the ${MAX_SPOT_DERIVATIVE_SKEW_MS / 1000}s tolerance`, skewMs };
  }
  return { aligned: true, skewMs };
}

/**
 * "Do not treat the existence of a Fyers response alone as authoritative
 * derivative eligibility." A contract is only treated as genuinely tradable
 * evidence when it has a real, positive last-traded price or a real bid/ask
 * -- a Fyers row that exists but carries no live quote (a delisted/illiquid
 * strike still listed in the chain) must not silently pass as "eligible."
 * @param {{ltp: number|null, bid: number|null, ask: number|null}} contract
 */
export function hasLiveQuote(contract) {
  if (!contract) return false;
  if (Number.isFinite(contract.ltp) && contract.ltp > 0) return true;
  if (Number.isFinite(contract.bid) && contract.bid > 0 && Number.isFinite(contract.ask) && contract.ask > 0) return true;
  return false;
}

/**
 * "Quarantine ambiguous mappings" -- a minimal, disclosed liquidity/quality
 * filter (spec: "Filter out illiquid contracts... missing or stale quotes...
 * excessive bid/ask spreads"). `maxSpreadFraction` is a disclosed
 * PROJECT_DEFAULT (0.15 = 15% of mid-price), not extracted from any FOME
 * source document, since none specifies a numeric liquidity threshold.
 * @param {{ltp: number|null, bid: number|null, ask: number|null, volume: number|null, oi: number|null}} contract
 * @param {{minVolume?: number, minOi?: number, maxSpreadFraction?: number}} [thresholds]
 * @returns {{liquid: boolean, reasons: string[]}}
 */
export function assessLiquidity(contract, { minVolume = 1, minOi = 1, maxSpreadFraction = 0.15 } = {}) {
  const reasons = [];
  if (!hasLiveQuote(contract)) reasons.push("no live quote");
  if (!Number.isFinite(contract?.volume) || contract.volume < minVolume) reasons.push("volume below minimum");
  if (!Number.isFinite(contract?.oi) || contract.oi < minOi) reasons.push("open interest below minimum");
  if (Number.isFinite(contract?.bid) && Number.isFinite(contract?.ask) && contract.bid > 0 && contract.ask > 0) {
    const mid = (contract.bid + contract.ask) / 2;
    const spreadFraction = mid > 0 ? (contract.ask - contract.bid) / mid : Infinity;
    if (spreadFraction > maxSpreadFraction) reasons.push(`bid/ask spread ${(spreadFraction * 100).toFixed(1)}% exceeds ${(maxSpreadFraction * 100).toFixed(0)}% tolerance`);
  }
  return { liquid: reasons.length === 0, reasons };
}

/**
 * "If an expiry cannot reasonably accommodate the technical target" -- a
 * minimal, disclosed check: is the selected expiry at least `minDaysAhead`
 * calendar days out? No FOME source document gives a numeric minimum;
 * `minDaysAhead` defaults to 2 (reject same-day/next-day expiry as
 * unable to accommodate a swing-style technical target), a disclosed
 * PROJECT_DEFAULT.
 * @param {number} expiryEpochSeconds
 * @param {Date} asOf
 * @param {number} [minDaysAhead]
 */
export function expirySuitableForTarget(expiryEpochSeconds, asOf, minDaysAhead = 2) {
  if (!Number.isFinite(expiryEpochSeconds)) return { suitable: false, reason: "expiry unavailable" };
  const daysAhead = (expiryEpochSeconds * 1000 - asOf.getTime()) / (24 * 60 * 60 * 1000);
  if (daysAhead < minDaysAhead) {
    return { suitable: false, reason: `expiry is only ${daysAhead.toFixed(1)} days out, below the ${minDaysAhead}-day minimum for a technical target to play out` };
  }
  return { suitable: true, daysAhead };
}

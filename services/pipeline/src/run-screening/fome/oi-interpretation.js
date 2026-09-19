// Deterministic open-interest interpretation for FOME's futures/options
// overlay -- pure functions, no I/O, mirroring strategies/fome.yaml's
// `futures_oi`/`call_oi`/`put_oi` matrices exactly (do not edit one without
// the other; these are the same documented matrix, just executable).
//
// Every function returns `null` (never a guessed bias) when either input
// change is exactly zero or not finite -- a flat price or flat OI is not one
// of the four documented quadrants, and AGENTS.md forbids converting
// ambiguity into a pass/classification.

function sign(value) {
  if (!Number.isFinite(value) || value === 0) return null;
  return value > 0 ? "up" : "down";
}

/**
 * Futures OI interpretation (fome.yaml `futures_oi`).
 * @param {{priceChangePct: number, oiChangePct: number}} input
 * @returns {{state: string, bias: "bullish"|"bearish"}|null}
 */
export function interpretFuturesOi({ priceChangePct, oiChangePct }) {
  const priceDir = sign(priceChangePct);
  const oiDir = sign(oiChangePct);
  if (!priceDir || !oiDir) return null;

  if (priceDir === "up" && oiDir === "up") return { state: "long_buildup", bias: "bullish" };
  if (priceDir === "down" && oiDir === "up") return { state: "short_buildup", bias: "bearish" };
  if (priceDir === "up" && oiDir === "down") return { state: "short_covering", bias: "bullish" };
  return { state: "long_covering", bias: "bearish" }; // priceDir === "down" && oiDir === "down"
}

/**
 * Call-option OI interpretation (fome.yaml `call_oi`).
 * @param {{premiumChangePct: number, oiChangePct: number}} input
 * @returns {"bullish_watchful"|"strong_bullish"|"bearish"|"strong_bearish"|null}
 */
export function interpretCallOi({ premiumChangePct, oiChangePct }) {
  const premiumDir = sign(premiumChangePct);
  const oiDir = sign(oiChangePct);
  if (!premiumDir || !oiDir) return null;

  if (premiumDir === "up" && oiDir === "up") return "bullish_watchful";
  if (premiumDir === "up" && oiDir === "down") return "strong_bullish";
  if (premiumDir === "down" && oiDir === "down") return "bearish";
  return "strong_bearish"; // premiumDir === "down" && oiDir === "up"
}

/**
 * Put-option OI interpretation (fome.yaml `put_oi`) -- the mirror image of
 * interpretCallOi's quadrants, per the documented matrix.
 * @param {{premiumChangePct: number, oiChangePct: number}} input
 * @returns {"bearish_watchful"|"strong_bearish"|"bullish"|"strong_bullish"|null}
 */
export function interpretPutOi({ premiumChangePct, oiChangePct }) {
  const premiumDir = sign(premiumChangePct);
  const oiDir = sign(oiChangePct);
  if (!premiumDir || !oiDir) return null;

  if (premiumDir === "up" && oiDir === "up") return "bearish_watchful";
  if (premiumDir === "up" && oiDir === "down") return "strong_bearish";
  if (premiumDir === "down" && oiDir === "down") return "bullish";
  return "strong_bullish"; // premiumDir === "down" && oiDir === "up"
}

/**
 * "Supportive" evidence for FOME-TREND-001/002's `option_oi_supportive`
 * input -- fome.yaml's compound clause only ever tests OI *direction*
 * ("building"/"shedding"), never the premium-derived bullish/bearish label,
 * so this reads `oiChangePct` directly rather than re-deriving it from
 * interpretCallOi/interpretPutOi's output (those labels mix premium AND OI
 * direction together and are NOT a reliable proxy for "building" alone --
 * e.g. interpretCallOi's "strong_bullish" is actually an OI-*shedding*
 * quadrant). Bullish qualification wants ATM PE building OI (oiChangePct >
 * 0) AND ATM/ITM CE shedding OI (oiChangePct < 0) -- fome.yaml's "Supportive:
 * ATM PE building OI and ATM & ITM CE shedding OI." Returns null (not
 * false) when either leg's OI-change figure is missing or exactly zero --
 * a genuine "don't know"/non-quadrant reading, not a documented non-match.
 * @param {{atmPutOiChangePct: number|null, atmOrItmCallOiChangePct: number|null}} input
 */
export function isBullishOptionOiSupportive({ atmPutOiChangePct, atmOrItmCallOiChangePct }) {
  const putDir = sign(atmPutOiChangePct);
  const callDir = sign(atmOrItmCallOiChangePct);
  if (!putDir || !callDir) return null;
  return putDir === "up" && callDir === "down";
}

/**
 * Mirror of isBullishOptionOiSupportive for the bearish qualification:
 * "ATM & ITM PE shedding OI and ATM CE building OI."
 * @param {{atmOrItmPutOiChangePct: number|null, atmCallOiChangePct: number|null}} input
 */
export function isBearishOptionOiSupportive({ atmOrItmPutOiChangePct, atmCallOiChangePct }) {
  const putDir = sign(atmOrItmPutOiChangePct);
  const callDir = sign(atmCallOiChangePct);
  if (!putDir || !callDir) return null;
  return putDir === "down" && callDir === "up";
}

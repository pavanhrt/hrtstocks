import { test } from "node:test";
import assert from "node:assert/strict";
import {
  selectNearestExpiry,
  selectStrikeLadder,
  checkSpotDerivativeAlignment,
  hasLiveQuote,
  assessLiquidity,
  expirySuitableForTarget,
  MAX_SPOT_DERIVATIVE_SKEW_MS,
} from "./contract-selection.js";

const asOf = new Date("2026-09-17T10:00:00Z");

test("selectNearestExpiry: picks the soonest future expiry and lists the rest as alternatives", () => {
  const expiries = [
    { date: "2026-10-30", expiryEpoch: Math.floor(new Date("2026-10-30T10:00:00Z").getTime() / 1000) },
    { date: "2026-09-25", expiryEpoch: Math.floor(new Date("2026-09-25T10:00:00Z").getTime() / 1000) },
  ];
  const { selected, alternatives } = selectNearestExpiry(expiries, asOf);
  assert.equal(selected.date, "2026-09-25");
  assert.equal(alternatives.length, 1);
  assert.equal(alternatives[0].date, "2026-10-30");
});

test("selectNearestExpiry: expiries already in the past are excluded, never selected", () => {
  const expiries = [{ date: "2026-09-01", expiryEpoch: Math.floor(new Date("2026-09-01T10:00:00Z").getTime() / 1000) }];
  const { selected, alternatives } = selectNearestExpiry(expiries, asOf);
  assert.equal(selected, null);
  assert.equal(alternatives.length, 0);
});

test("selectStrikeLadder: calls -- ITM is the lower strike, OTM is the higher strike", () => {
  const calls = [{ strike: 90 }, { strike: 100 }, { strike: 110 }];
  const { atm, itm, otm } = selectStrikeLadder(calls, 100, "CE");
  assert.equal(atm.strike, 100);
  assert.equal(itm.strike, 90);
  assert.equal(otm.strike, 110);
});

test("selectStrikeLadder: puts -- ITM is the HIGHER strike, OTM is the LOWER strike (opposite of calls)", () => {
  const puts = [{ strike: 90 }, { strike: 100 }, { strike: 110 }];
  const { atm, itm, otm } = selectStrikeLadder(puts, 100, "PE");
  assert.equal(atm.strike, 100);
  assert.equal(itm.strike, 110);
  assert.equal(otm.strike, 90);
});

test("selectStrikeLadder: never fabricates a leg that doesn't exist in the chain", () => {
  const calls = [{ strike: 100 }];
  const { atm, itm, otm } = selectStrikeLadder(calls, 100, "CE");
  assert.equal(atm.strike, 100);
  assert.equal(itm, null);
  assert.equal(otm, null);
});

test("checkSpotDerivativeAlignment: within tolerance is aligned", () => {
  const spotTs = "2026-09-17T10:00:00Z";
  const derivTs = "2026-09-17T10:01:00Z";
  const result = checkSpotDerivativeAlignment(spotTs, derivTs);
  assert.equal(result.aligned, true);
});

test("checkSpotDerivativeAlignment: exceeding tolerance blocks alignment", () => {
  const spotTs = "2026-09-17T10:00:00Z";
  const derivTs = new Date(new Date(spotTs).getTime() + MAX_SPOT_DERIVATIVE_SKEW_MS + 60_000).toISOString();
  const result = checkSpotDerivativeAlignment(spotTs, derivTs);
  assert.equal(result.aligned, false);
  assert.match(result.reason, /exceeding/);
});

test("checkSpotDerivativeAlignment: missing timestamp blocks alignment, never assumed aligned", () => {
  assert.equal(checkSpotDerivativeAlignment(null, "2026-09-17T10:00:00Z").aligned, false);
  assert.equal(checkSpotDerivativeAlignment("2026-09-17T10:00:00Z", null).aligned, false);
});

test("hasLiveQuote: a real ltp or a real bid/ask pair counts; zeros/nulls do not", () => {
  assert.equal(hasLiveQuote({ ltp: 12.5, bid: null, ask: null }), true);
  assert.equal(hasLiveQuote({ ltp: 0, bid: 10, ask: 11 }), true);
  assert.equal(hasLiveQuote({ ltp: 0, bid: 0, ask: 0 }), false);
  assert.equal(hasLiveQuote(null), false);
});

test("assessLiquidity: a healthy contract passes with no reasons", () => {
  const { liquid, reasons } = assessLiquidity({ ltp: 10, bid: 9.8, ask: 10.2, volume: 500, oi: 5000 });
  assert.equal(liquid, true);
  assert.equal(reasons.length, 0);
});

test("assessLiquidity: excessive bid/ask spread is flagged, not silently passed", () => {
  const { liquid, reasons } = assessLiquidity({ ltp: 10, bid: 5, ask: 15, volume: 500, oi: 5000 });
  assert.equal(liquid, false);
  assert.ok(reasons.some((r) => r.includes("spread")));
});

test("assessLiquidity: missing quote/volume/OI are each flagged, never assumed fine", () => {
  const { liquid, reasons } = assessLiquidity({ ltp: null, bid: null, ask: null, volume: 0, oi: 0 });
  assert.equal(liquid, false);
  assert.equal(reasons.length, 3);
});

test("expirySuitableForTarget: an expiry far enough out is suitable", () => {
  const expiryEpoch = Math.floor(new Date("2026-09-30T10:00:00Z").getTime() / 1000);
  const result = expirySuitableForTarget(expiryEpoch, asOf, 2);
  assert.equal(result.suitable, true);
});

test("expirySuitableForTarget: an expiry too close is not suitable, with a stated reason", () => {
  const expiryEpoch = Math.floor(new Date("2026-09-17T15:00:00Z").getTime() / 1000);
  const result = expirySuitableForTarget(expiryEpoch, asOf, 2);
  assert.equal(result.suitable, false);
  assert.match(result.reason, /days out/);
});

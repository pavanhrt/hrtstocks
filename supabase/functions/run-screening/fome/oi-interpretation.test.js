import { test } from "node:test";
import assert from "node:assert/strict";
import {
  interpretFuturesOi,
  interpretCallOi,
  interpretPutOi,
  isBullishOptionOiSupportive,
  isBearishOptionOiSupportive,
} from "./oi-interpretation.js";

test("interpretFuturesOi: all four documented quadrants", () => {
  assert.deepEqual(interpretFuturesOi({ priceChangePct: 1, oiChangePct: 1 }), { state: "long_buildup", bias: "bullish" });
  assert.deepEqual(interpretFuturesOi({ priceChangePct: -1, oiChangePct: 1 }), { state: "short_buildup", bias: "bearish" });
  assert.deepEqual(interpretFuturesOi({ priceChangePct: 1, oiChangePct: -1 }), { state: "short_covering", bias: "bullish" });
  assert.deepEqual(interpretFuturesOi({ priceChangePct: -1, oiChangePct: -1 }), { state: "long_covering", bias: "bearish" });
});

test("interpretFuturesOi: flat price or flat OI is not a quadrant", () => {
  assert.equal(interpretFuturesOi({ priceChangePct: 0, oiChangePct: 1 }), null);
  assert.equal(interpretFuturesOi({ priceChangePct: 1, oiChangePct: 0 }), null);
  assert.equal(interpretFuturesOi({ priceChangePct: NaN, oiChangePct: 1 }), null);
});

test("interpretCallOi: all four documented quadrants", () => {
  assert.equal(interpretCallOi({ premiumChangePct: 1, oiChangePct: 1 }), "bullish_watchful");
  assert.equal(interpretCallOi({ premiumChangePct: 1, oiChangePct: -1 }), "strong_bullish");
  assert.equal(interpretCallOi({ premiumChangePct: -1, oiChangePct: -1 }), "bearish");
  assert.equal(interpretCallOi({ premiumChangePct: -1, oiChangePct: 1 }), "strong_bearish");
});

test("interpretPutOi: all four documented quadrants (mirrors call_oi)", () => {
  assert.equal(interpretPutOi({ premiumChangePct: 1, oiChangePct: 1 }), "bearish_watchful");
  assert.equal(interpretPutOi({ premiumChangePct: 1, oiChangePct: -1 }), "strong_bearish");
  assert.equal(interpretPutOi({ premiumChangePct: -1, oiChangePct: -1 }), "bullish");
  assert.equal(interpretPutOi({ premiumChangePct: -1, oiChangePct: 1 }), "strong_bullish");
});

test("isBullishOptionOiSupportive: PE building + CE shedding is supportive", () => {
  assert.equal(isBullishOptionOiSupportive({ atmPutOiChangePct: 5, atmOrItmCallOiChangePct: -5 }), true);
});

test("isBullishOptionOiSupportive: PE shedding is not supportive", () => {
  assert.equal(isBullishOptionOiSupportive({ atmPutOiChangePct: -5, atmOrItmCallOiChangePct: -5 }), false);
});

test("isBullishOptionOiSupportive: missing leg is null, never a guessed pass/fail", () => {
  assert.equal(isBullishOptionOiSupportive({ atmPutOiChangePct: null, atmOrItmCallOiChangePct: -5 }), null);
  assert.equal(isBullishOptionOiSupportive({ atmPutOiChangePct: 5, atmOrItmCallOiChangePct: 0 }), null);
});

test("isBearishOptionOiSupportive: PE shedding + CE building is supportive", () => {
  assert.equal(isBearishOptionOiSupportive({ atmOrItmPutOiChangePct: -5, atmCallOiChangePct: 5 }), true);
});

test("isBearishOptionOiSupportive: CE shedding is not supportive", () => {
  assert.equal(isBearishOptionOiSupportive({ atmOrItmPutOiChangePct: -5, atmCallOiChangePct: -5 }), false);
});

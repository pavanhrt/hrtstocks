import { test } from "node:test";
import assert from "node:assert/strict";
import { detectCandlestickPatterns, detectDoubleExtremePatterns } from "./patterns.js";

function bar(date, open, high, low, close, volume = 100000) {
  return { date, open, high, low, close, volume };
}

function downtrendInto(date0price) {
  // 6 bars trending down into the pattern under test, each lower than the last.
  const bars = [];
  let price = date0price + 12;
  for (let i = 0; i < 6; i++) {
    bars.push(bar(`2024-01-${String(i + 1).padStart(2, "0")}`, price + 1, price + 1.5, price - 1, price, 100000));
    price -= 2;
  }
  return bars;
}

function uptrendInto(date0price) {
  const bars = [];
  let price = date0price - 12;
  for (let i = 0; i < 6; i++) {
    bars.push(bar(`2024-01-${String(i + 1).padStart(2, "0")}`, price - 1, price + 1, price - 1.5, price, 100000));
    price += 2;
  }
  return bars;
}

test("detectCandlestickPatterns finds a Bullish Engulfing after a downtrend and marks it TRIGGERED", () => {
  const bars = [...downtrendInto(20), bar("2024-01-07", 20, 20.2, 17, 19), bar("2024-01-08", 18.5, 23, 18.3, 22.5)];
  const results = detectCandlestickPatterns(bars);
  const hit = results.find((r) => r.patternName === "Bullish Engulfing");
  assert.ok(hit, "expected a Bullish Engulfing detection");
  assert.equal(hit.direction, "bullish");
  assert.equal(hit.state, "TRIGGERED");
  assert.equal(hit.sourceLocator, "smm-chart-analysis-SKILL.md §4-§5 / papa-price-action-SKILL.md §1");
});

test("detectCandlestickPatterns finds a Bearish Engulfing after an uptrend", () => {
  const bars = [...uptrendInto(20), bar("2024-01-07", 20, 20.2, 17.8, 22), bar("2024-01-08", 22.5, 22.7, 17, 18)];
  const results = detectCandlestickPatterns(bars);
  const hit = results.find((r) => r.patternName === "Bearish Engulfing");
  assert.ok(hit);
  assert.equal(hit.direction, "bearish");
  assert.equal(hit.state, "TRIGGERED");
});

test("detectCandlestickPatterns does not report an engulfing pattern when the body doesn't fully engulf", () => {
  const bars = [...downtrendInto(20), bar("2024-01-07", 20, 20.2, 17, 19), bar("2024-01-08", 19.2, 20, 19, 19.8)];
  const results = detectCandlestickPatterns(bars);
  assert.equal(
    results.find((r) => r.patternName === "Bullish Engulfing"),
    undefined
  );
});

test("detectCandlestickPatterns finds a Hammer only at the bottom of a downtrend", () => {
  // body 10..10.3 (bsz=0.3): lower wick 3 (>=2x body), upper wick 0.05 (<=0.6x body)
  const downBars = [...downtrendInto(20), bar("2024-01-07", 10, 10.35, 7, 10.3)];
  const results = detectCandlestickPatterns(downBars);
  const hammer = results.find((r) => r.patternName === "Hammer");
  assert.ok(hammer, "expected Hammer at the bottom of a downtrend");
  assert.equal(hammer.direction, "bullish");
  assert.equal(hammer.state, "TRIGGERED");

  const upBars = [...uptrendInto(20), bar("2024-01-07", 20, 20.35, 17, 20.3)];
  const noHammerInUptrend = detectCandlestickPatterns(upBars).find((r) => r.patternName === "Hammer");
  assert.equal(noHammerInUptrend, undefined, "hammer shape in an uptrend is not a Hammer signal");
});

test("detectCandlestickPatterns finds a Shooting Star at the top of an uptrend", () => {
  // body 20.3..20.35 (bsz=0.05): upper wick 3.15 (>=2x body), lower wick 0 (<=0.6x body)
  const bars = [...uptrendInto(20), bar("2024-01-07", 20.3, 23.5, 20.3, 20.35)];
  const star = detectCandlestickPatterns(bars).find((r) => r.patternName === "Shooting Star");
  assert.ok(star);
  assert.equal(star.direction, "bearish");
});

test("detectCandlestickPatterns requires a following red candle for Hanging Man to be TRIGGERED, else OBSERVED", () => {
  const withoutFollowUp = [...uptrendInto(20), bar("2024-01-07", 20.3, 20.35, 17, 20.35)];
  const observed = detectCandlestickPatterns(withoutFollowUp).find((r) => r.patternName === "Hanging Man");
  assert.ok(observed);
  assert.equal(observed.state, "OBSERVED");

  const withFollowUp = [...withoutFollowUp, bar("2024-01-08", 20, 20.1, 18, 18.5)];
  const triggered = detectCandlestickPatterns(withFollowUp).find((r) => r.patternName === "Hanging Man");
  assert.ok(triggered);
  assert.equal(triggered.state, "TRIGGERED");
  assert.equal(triggered.triggerBarDate, "2024-01-08");
});

test("detectCandlestickPatterns finds Bullish Piercing (close beyond the prior candle's median) and Dark Cloud Cover", () => {
  const piercing = [...downtrendInto(20), bar("2024-01-07", 20, 20.2, 17, 18), bar("2024-01-08", 17.5, 20.5, 17.3, 19.5)];
  const piercingHit = detectCandlestickPatterns(piercing).find((r) => r.patternName === "Bullish Piercing");
  assert.ok(piercingHit);
  assert.equal(piercingHit.direction, "bullish");

  const darkCloud = [...uptrendInto(20), bar("2024-01-07", 18, 20.5, 17.8, 20), bar("2024-01-08", 20.5, 20.7, 17.5, 18.5)];
  const darkCloudHit = detectCandlestickPatterns(darkCloud).find((r) => r.patternName === "Bearish Dark Cloud Cover");
  assert.ok(darkCloudHit);
  assert.equal(darkCloudHit.direction, "bearish");
});

test("detectCandlestickPatterns finds Morning Star and Evening Star 3-candle formations", () => {
  const morning = [
    ...downtrendInto(20).slice(0, 4),
    bar("2024-01-05", 14, 14.2, 10, 10.5), // long red
    bar("2024-01-06", 10.3, 10.6, 10, 10.4), // small body
    bar("2024-01-07", 10.5, 13.5, 10.4, 13), // strong green closing above c1's median
  ];
  const morningHit = detectCandlestickPatterns(morning).find((r) => r.patternName === "Morning Star");
  assert.ok(morningHit, "expected Morning Star");
  assert.equal(morningHit.direction, "bullish");

  const evening = [
    ...uptrendInto(20).slice(0, 4),
    bar("2024-01-05", 20, 24, 19.8, 23.5), // long green
    bar("2024-01-06", 23.6, 23.9, 23.4, 23.7), // small body
    bar("2024-01-07", 23.5, 23.6, 20, 20.5), // strong red closing below c1's median
  ];
  const eveningHit = detectCandlestickPatterns(evening).find((r) => r.patternName === "Evening Star");
  assert.ok(eveningHit, "expected Evening Star");
  assert.equal(eveningHit.direction, "bearish");
});

test("detectDoubleExtremePatterns finds a Double Top within tolerance, prior uptrend required, and triggers on a neckline close", () => {
  const pivots = [
    { type: "HL", price: 90, date: "2024-01-01" },
    { type: "HH", price: 120, date: "2024-02-01" }, // first top, confirmed higher than prior high -> genuine uptrend
    { type: "HL", price: 100, date: "2024-03-01" }, // trough / neckline
    { type: "EH", price: 121, date: "2024-04-01" }, // second top, within ~3% of 120
  ];
  const bars = [
    bar("2024-04-01", 118, 121, 117, 121), // the second pivot bar itself
    bar("2024-04-02", 120, 121, 105, 108),
    bar("2024-04-03", 108, 109, 95, 96), // closes below neckline (100) -> trigger
  ];
  const results = detectDoubleExtremePatterns(pivots, bars);
  const hit = results.find((r) => r.patternName === "Double Top");
  assert.ok(hit, "expected a Double Top");
  assert.equal(hit.direction, "bearish");
  assert.equal(hit.state, "TRIGGERED");
  assert.equal(hit.triggerBarDate, "2024-04-03");
  assert.equal(hit.targetPrice, 100 - (120 - 100));
});

test("detectDoubleExtremePatterns finds a Double Bottom within tolerance and stays OBSERVED until the neckline breaks", () => {
  const pivots = [
    { type: "LH", price: 130, date: "2024-01-01" },
    { type: "LL", price: 90, date: "2024-02-01" },
    { type: "LH", price: 110, date: "2024-03-01" }, // neckline
    { type: "EL", price: 91, date: "2024-04-01" },
  ];
  const bars = [
    bar("2024-04-01", 93, 94, 90, 91), // the second pivot bar itself
    bar("2024-04-02", 91, 105, 90, 100), // no close above neckline (110) yet
  ];
  const results = detectDoubleExtremePatterns(pivots, bars);
  const hit = results.find((r) => r.patternName === "Double Bottom");
  assert.ok(hit);
  assert.equal(hit.direction, "bullish");
  assert.equal(hit.state, "OBSERVED");
  assert.equal(hit.targetPrice, null);
});

test("detectDoubleExtremePatterns rejects a pair of highs outside the tolerance (that's a fresh HH or a plain LH, not a double top)", () => {
  const pivots = [
    { type: "HL", price: 90, date: "2024-01-01" },
    { type: "HH", price: 120, date: "2024-02-01" },
    { type: "HL", price: 100, date: "2024-03-01" },
    { type: "HH", price: 140, date: "2024-04-01" }, // 16% higher -- a genuine new high, not comparable
  ];
  const bars = [bar("2024-04-02", 140, 141, 95, 96)];
  const results = detectDoubleExtremePatterns(pivots, bars);
  assert.equal(results.find((r) => r.patternName === "Double Top"), undefined);
});

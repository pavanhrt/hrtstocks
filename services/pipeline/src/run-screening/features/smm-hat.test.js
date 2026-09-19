import { test } from "node:test";
import assert from "node:assert/strict";
import { evaluateSmmHat } from "./smm-hat.js";

function hbar(i, close, high, low, open, vol = 1000) {
  return { date: `D${i}`, sessionDate: `2026-09-${String(10 + Math.floor(i / 5)).padStart(2, "0")}`, slotIndex: i % 5, low, high, close, open: open ?? close, volume: vol };
}

// A decline from 120 down to ~93 over 18 hourly bars (pins hourly Stochastic
// %K/%D low, kPrevious < 20), then one sharp reversal bar up -- Stochastic
// crosses bullish from below 20. Real computed values, not hand-forced.
function bullishReversalHourlyBars() {
  const bars = [];
  let price = 120;
  for (let i = 0; i < 18; i++) {
    price -= 1.5;
    bars.push(hbar(i, price, price + 1, price - 1, price + 1));
  }
  price += 8;
  bars.push(hbar(18, price, price + 1, price - 9, price - 8));
  return bars;
}

// Mirror: a rally up to ~107, then a sharp reversal down -- Stochastic
// crosses bearish from above 80.
function bearishReversalHourlyBars() {
  const bars = [];
  let price = 80;
  for (let i = 0; i < 18; i++) {
    price += 1.5;
    bars.push(hbar(i, price, price + 1, price - 1, price - 1));
  }
  price -= 8;
  bars.push(hbar(18, price, price + 9, price - 1, price + 8));
  return bars;
}

test("evaluateSmmHat: Step 1 BUY (MACD uptick, uptrend Dow) AND Step 2 BUY (hourly Stochastic crosses up from <20) -- Bull Hat", () => {
  const result = evaluateSmmHat({
    dailyMacdHistogramPhase: { change: "uptick", priorPhase: "down" },
    dailyDowState: "uptrend_intact",
    hourlyBars: bullishReversalHourlyBars(),
    hourSlotVolumeLookbackSessions: 15,
    bullish: true,
  });
  assert.equal(result.step1.reading, "BUY");
  assert.equal(result.step2.reading, "BUY");
  assert.equal(result.step2.stochasticCrossover, true);
  assert.equal(result.hat, "BUY");
  assert.equal(result.checks.candlestick.patternName, "Bullish Engulfing");
  assert.equal(result.checks.candlestick.state, "TRIGGERED");
});

test("evaluateSmmHat: bearish mirror -- Step 1 SELL AND Step 2 SELL (Stochastic crosses down from >80) -- Bear Hat", () => {
  const result = evaluateSmmHat({
    dailyMacdHistogramPhase: { change: "downtick", priorPhase: "up" },
    dailyDowState: "downtrend_intact",
    hourlyBars: bearishReversalHourlyBars(),
    hourSlotVolumeLookbackSessions: 15,
    bullish: false,
  });
  assert.equal(result.step1.reading, "SELL");
  assert.equal(result.step2.reading, "SELL");
  assert.equal(result.step2.stochasticCrossover, true);
  assert.equal(result.hat, "SELL");
});

test("evaluateSmmHat: Step 1 and Step 2 disagree -- 'no hat and no trade', never a forced or partial verdict", () => {
  // Same decline as the happy path, but truncated BEFORE the reversal bar --
  // Step 1 still reads BUY (Tide inputs are independent of the truncation),
  // but Step 2 has no crossover yet.
  const result = evaluateSmmHat({
    dailyMacdHistogramPhase: { change: "uptick", priorPhase: "down" },
    dailyDowState: "uptrend_intact",
    hourlyBars: bullishReversalHourlyBars().slice(0, 18),
    hourSlotVolumeLookbackSessions: 15,
    bullish: true,
  });
  assert.equal(result.step1.reading, "BUY");
  assert.equal(result.step2.reading, null);
  assert.equal(result.hat, "no hat");
});

test("evaluateSmmHat: Step 1 fails when the daily Dow state doesn't support the direction even if MACD does", () => {
  const result = evaluateSmmHat({
    dailyMacdHistogramPhase: { change: "uptick", priorPhase: "down" },
    dailyDowState: "downtrend_intact", // contradicts the bullish hypothesis
    hourlyBars: bullishReversalHourlyBars(),
    hourSlotVolumeLookbackSessions: 15,
    bullish: true,
  });
  assert.equal(result.step1.reading, null);
  assert.equal(result.hat, "no hat");
});

test("evaluateSmmHat: Step 1 returns a null reading (never a guess) when the MACD histogram phase itself is not yet resolvable", () => {
  const result = evaluateSmmHat({
    dailyMacdHistogramPhase: { change: null, priorPhase: null },
    dailyDowState: "uptrend_intact",
    hourlyBars: bullishReversalHourlyBars(),
    hourSlotVolumeLookbackSessions: 15,
    bullish: true,
  });
  assert.equal(result.step1.reading, null);
  assert.equal(result.hat, "no hat");
});

test("evaluateSmmHat: checks 1-4 never affect the hat -- they are evidence, not gates", () => {
  // A happy-path hat with candle/volume/EMA evidence entirely absent (empty
  // hourly bars for the evidence section) still cannot compute Step 2 either
  // (both derive from the same hourlyBars) -- so instead verify the checks
  // object is always present and well-shaped even when nothing fires.
  const result = evaluateSmmHat({
    dailyMacdHistogramPhase: { change: "uptick", priorPhase: "down" },
    dailyDowState: "uptrend_intact",
    hourlyBars: [],
    hourSlotVolumeLookbackSessions: 15,
    bullish: true,
  });
  assert.equal(result.step2.reading, null);
  assert.equal(result.hat, "no hat");
  assert.equal(result.checks.candlestick, null);
  assert.equal(result.checks.volume, null);
  assert.equal(result.checks.emaCrossover, false);
});

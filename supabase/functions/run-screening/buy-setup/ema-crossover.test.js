import { test } from "node:test";
import assert from "node:assert/strict";
import { detectEmaCrossover, detectPositiveEmaCrossoverEvidence } from "./ema-crossover.js";

function bar(date, close) {
  return { date, open: close, high: close + 1, low: close - 1, close };
}

/** 30 flat bars at 100, then 10 rising bars -- verified (via a scratch script)
 * that EMA(5) crosses above EMA(13) for the first time exactly at index 30
 * (bar "r0"), 9 bars before the end of a 40-bar series. */
function crossoverBars() {
  const bars = [];
  for (let i = 0; i < 30; i++) bars.push(bar(`f${i}`, 100));
  for (let i = 0; i < 10; i++) bars.push(bar(`r${i}`, 100 + (i + 1) * 3));
  return bars;
}

test("detectEmaCrossover: TRIGGERED when the crossover bar falls inside the confirmation window", () => {
  const result = detectEmaCrossover(crossoverBars(), { fastPeriod: 5, slowPeriod: 13, confirmationWindow: 10 });
  assert.equal(result.status, "TRIGGERED");
  assert.equal(result.crossoverBarDate, "r0");
  assert.ok(result.fastValue > result.slowValue);
});

test("detectEmaCrossover: ALREADY_ABOVE when fast is above slow but the crossover happened outside the window", () => {
  const result = detectEmaCrossover(crossoverBars(), { fastPeriod: 5, slowPeriod: 13, confirmationWindow: 9 });
  assert.equal(result.status, "ALREADY_ABOVE");
  assert.equal(result.crossoverBarDate, null);
});

test("detectEmaCrossover: NOT_TRIGGERED when fast has never crossed above slow", () => {
  const flat = Array.from({ length: 30 }, (_, i) => bar(`f${i}`, 100));
  const result = detectEmaCrossover(flat, { fastPeriod: 5, slowPeriod: 13, confirmationWindow: 5 });
  assert.equal(result.status, "NOT_TRIGGERED");
});

test("detectEmaCrossover: NO_DATA when there are not enough bars for the slow EMA, never a guessed status", () => {
  const short = Array.from({ length: 5 }, (_, i) => bar(`f${i}`, 100 + i));
  const result = detectEmaCrossover(short, { fastPeriod: 5, slowPeriod: 13, confirmationWindow: 3 });
  assert.equal(result.status, "NO_DATA");
  assert.equal(result.fastValue, null);
  assert.equal(result.slowValue, null);
});

test("detectEmaCrossover: NO_DATA for fewer than 2 bars", () => {
  const result = detectEmaCrossover([bar("only", 100)], { fastPeriod: 5, slowPeriod: 13, confirmationWindow: 3 });
  assert.equal(result.status, "NO_DATA");
});

/** 15 flat bars then 4 rising bars (19 total): EMA(5) crosses EMA(13) at
 * index 15, but 19 bars is not enough for EMA(26) to have any value at all
 * -- verified via a scratch script. Exercises the OR semantics: one slow
 * period genuinely triggers while the other is honestly NO_DATA, not
 * silently merged into a single AND/OR result. */
function orLogicBars() {
  const bars = [];
  for (let i = 0; i < 15; i++) bars.push(bar(`f${i}`, 100));
  for (let i = 0; i < 4; i++) bars.push(bar(`r${i}`, 100 + (i + 1) * 5));
  return bars;
}

test("detectPositiveEmaCrossoverEvidence: EMA5>EMA13 OR EMA5>EMA26 -- overall TRIGGERED when only one slow period actually crossed", () => {
  const evidence = detectPositiveEmaCrossoverEvidence(orLogicBars(), { fastPeriod: 5, slowPeriods: [13, 26], confirmationWindow: 4 });
  assert.equal(evidence.overallStatus, "TRIGGERED");
  const thirteen = evidence.perSlowPeriod.find((r) => r.slowPeriod === 13);
  const twentySix = evidence.perSlowPeriod.find((r) => r.slowPeriod === 26);
  assert.equal(thirteen.status, "TRIGGERED");
  assert.equal(twentySix.status, "NO_DATA");
});

test("detectPositiveEmaCrossoverEvidence: never silently narrows OR into AND -- one NOT_TRIGGERED period does not veto another's TRIGGERED", () => {
  const evidence = detectPositiveEmaCrossoverEvidence(crossoverBars(), { fastPeriod: 5, slowPeriods: [13, 999], confirmationWindow: 10 });
  // slowPeriod 999 can never resolve (not enough bars) -- NO_DATA, not a veto.
  assert.equal(evidence.overallStatus, "TRIGGERED");
});

test("detectPositiveEmaCrossoverEvidence: NO_DATA only when every slow period is NO_DATA", () => {
  const short = Array.from({ length: 3 }, (_, i) => bar(`f${i}`, 100 + i));
  const evidence = detectPositiveEmaCrossoverEvidence(short, { fastPeriod: 5, slowPeriods: [13, 26], confirmationWindow: 3 });
  assert.equal(evidence.overallStatus, "NO_DATA");
});

import { test } from "node:test";
import assert from "node:assert/strict";
import { evaluateConfirmationGroups } from "./confirmation-groups.js";

const FULL_ROUTE = {
  requiredChecksPassed: true,
  wave2RetracementFraction: 0.5, // inside the 38.2-61.8% band
  volume: { triggerAboveHourSlotAverage: true },
};

const FULL_SMM_HAT = {
  step1: { reading: "BUY" },
  step2: { reading: "BUY" },
  checks: {
    candlestick: { patternName: "Bullish Engulfing" },
    volume: { aboveHourSlotAverage: true },
    emaCrossover: true,
  },
};

test("evaluateConfirmationGroups: every group supportive -- 5 of 5, passed", () => {
  const result = evaluateConfirmationGroups({
    directionLockPassed: true,
    selectedRoute: FULL_ROUTE,
    papaFormationTriggered: true,
    smmHat: FULL_SMM_HAT,
    adxCondition: { wait: false },
  });
  assert.equal(result.passedCount, 5);
  assert.equal(result.passed, true);
  assert.equal(result.groups.structureAndLevel.supportive, true);
  assert.equal(result.groups.emaAndFibonacci.supportive, true);
  assert.equal(result.groups.momentum.supportive, true);
  assert.equal(result.groups.priceActionAndPattern.supportive, true);
  assert.equal(result.groups.participationAndRegime.supportive, true);
});

test("evaluateConfirmationGroups: direction lock hasn't passed -- structureAndLevel fails, and with everything else stripped the overall gate fails too", () => {
  const result = evaluateConfirmationGroups({
    directionLockPassed: false,
    selectedRoute: null,
    papaFormationTriggered: false,
    smmHat: null,
    adxCondition: null,
  });
  assert.equal(result.groups.structureAndLevel.supportive, false);
  assert.equal(result.passedCount, 0);
  assert.equal(result.passed, false);
});

test("evaluateConfirmationGroups: exactly 3 of 5 supportive fails the >=4-of-5 gate", () => {
  const result = evaluateConfirmationGroups({
    directionLockPassed: true,
    selectedRoute: FULL_ROUTE, // structureAndLevel + emaAndFibonacci + participationAndRegime supportive
    papaFormationTriggered: false,
    smmHat: null, // momentum and priceActionAndPattern both need smmHat -- neither supportive
    adxCondition: { wait: false },
  });
  assert.equal(result.groups.structureAndLevel.supportive, true);
  assert.equal(result.groups.emaAndFibonacci.supportive, true);
  assert.equal(result.groups.momentum.supportive, false);
  assert.equal(result.groups.priceActionAndPattern.supportive, false);
  assert.equal(result.groups.participationAndRegime.supportive, true);
  assert.equal(result.passedCount, 3);
  assert.equal(result.passed, false);
});

test("evaluateConfirmationGroups: an explicit ADX combination-matrix WAIT blocks participationAndRegime even with volume supportive", () => {
  const result = evaluateConfirmationGroups({
    directionLockPassed: true,
    selectedRoute: FULL_ROUTE,
    papaFormationTriggered: true,
    smmHat: FULL_SMM_HAT,
    adxCondition: { wait: true, reason: "hourly ADX 9.10 < 14" },
  });
  assert.equal(result.groups.participationAndRegime.supportive, false);
  assert.equal(result.passedCount, 4); // every other group still supportive
  assert.equal(result.passed, true); // >=4-of-5 still clears
});

test("evaluateConfirmationGroups: missing ADX data (not yet computed) does not itself count against participationAndRegime", () => {
  const result = evaluateConfirmationGroups({
    directionLockPassed: true,
    selectedRoute: FULL_ROUTE,
    papaFormationTriggered: false,
    smmHat: null,
    adxCondition: null,
  });
  assert.equal(result.groups.participationAndRegime.supportive, true); // volume alone is enough when ADX is simply not computed yet
});

test("evaluateConfirmationGroups: SELL-1's route shape (no Fibonacci field, wave3-vs-wave5 volume comparison) is read correctly", () => {
  const sell1Route = { requiredChecksPassed: true, waveVolumeComparison: { wave3ExceedsWave5: true } };
  const result = evaluateConfirmationGroups({
    directionLockPassed: true,
    selectedRoute: sell1Route,
    papaFormationTriggered: false,
    smmHat: null,
    adxCondition: null,
  });
  assert.equal(result.groups.emaAndFibonacci.supportive, false); // SELL-1 has no Fibonacci check of its own, and no M7 EMA evidence here
  assert.equal(result.groups.participationAndRegime.supportive, true); // read via waveVolumeComparison, not the BUY-1/SELL-3 shape
});

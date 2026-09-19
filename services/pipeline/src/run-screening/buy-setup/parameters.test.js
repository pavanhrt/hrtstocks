import { test } from "node:test";
import assert from "node:assert/strict";
import { resolveBuySetupParameters, emaCrossoverPeriods } from "./parameters.js";

function fullValues(overrides = {}) {
  return {
    parameter_version: "1.6.0",
    documented: {
      ema_periods: [5, 13, 26, 50, 100, 200],
      rsi_period: 14,
      stochastic_lookback: 14,
      stochastic_smoothing: 3,
      bollinger_lookback: 20,
      standard_bollinger_deviation: 2.0,
      adx_dmi_period: 14,
      macd_fast: 12,
      macd_slow: 26,
      macd_signal: 9,
      volume_lookback: 20,
      volume_multiplier: 1.0,
      zigzag_daily_pct: 0.025,
    },
    buy_setup_analysis_defaults: {
      pivot_left_window: 3,
      pivot_right_window: 3,
      support_resistance_tolerance: 0.005,
      sr_touch_count_min: 2,
      breakout_buffer: 0.005,
      channel_min_pivots: 4,
      channel_slope_threshold: 0.001,
      ema_crossover_confirmation_window: 3,
      divergence_lookback: 60,
      zigzag_fifteen_minute_pct: 0.01,
    },
    ...overrides,
  };
}

test("resolveBuySetupParameters pins the given row's id and version", () => {
  const resolved = resolveBuySetupParameters({ id: "abc-123", version: "1.6.0", values: fullValues() });
  assert.equal(resolved.parameterVersionId, "abc-123");
  assert.equal(resolved.parameterVersion, "1.6.0");
  assert.equal(resolved.rsiPeriod, 14);
  assert.equal(resolved.pivotLeftWindow, 3);
});

test("resolveBuySetupParameters throws when a required field is missing rather than substituting a hardcoded default", () => {
  const values = fullValues();
  delete values.buy_setup_analysis_defaults.pivot_left_window;
  assert.throws(() => resolveBuySetupParameters({ id: "abc", version: "1.6.0", values }), /pivotLeftWindow/);
});

test("resolveBuySetupParameters throws without a row id -- refuses to guess an unpinned parameter set", () => {
  assert.throws(() => resolveBuySetupParameters({ values: fullValues() }));
  assert.throws(() => resolveBuySetupParameters(null));
});

test("pinning: resolving two DIFFERENT rows never lets the newer one affect the older one's already-resolved result", () => {
  const oldRow = { id: "old-id", version: "1.5.0", values: fullValues({ documented: { ...fullValues().documented, rsi_period: 21 } }) };
  const newRow = { id: "new-id", version: "1.6.0", values: fullValues() };

  const resolvedOld = resolveBuySetupParameters(oldRow);
  // Simulate "configuration changed after enrichment started" -- resolving
  // the NEW row must not retroactively change what was already resolved
  // from the OLD row (they are independent objects, not shared mutable
  // state).
  const resolvedNew = resolveBuySetupParameters(newRow);

  assert.equal(resolvedOld.rsiPeriod, 21);
  assert.equal(resolvedOld.parameterVersionId, "old-id");
  assert.equal(resolvedNew.rsiPeriod, 14);
  assert.equal(resolvedNew.parameterVersionId, "new-id");
  // The old result is still exactly what it was -- resolving the new row did not mutate it.
  assert.equal(resolvedOld.rsiPeriod, 21);
});

test("emaCrossoverPeriods extracts fast=5 and the documented 13/26 slow periods", () => {
  const resolved = resolveBuySetupParameters({ id: "abc", version: "1.6.0", values: fullValues() });
  const { fastPeriod, slowPeriods } = emaCrossoverPeriods(resolved);
  assert.equal(fastPeriod, 5);
  assert.deepEqual(slowPeriods, [13, 26]);
});

test("emaCrossoverPeriods throws if documented ema_periods lacks both 13 and 26", () => {
  const resolved = resolveBuySetupParameters({ id: "abc", version: "1.6.0", values: fullValues({ documented: { ...fullValues().documented, ema_periods: [5, 50, 100] } }) });
  assert.throws(() => emaCrossoverPeriods(resolved));
});

import { test } from "node:test";
import assert from "node:assert/strict";
import {
  ANALYSIS_SERIES_VERSION,
  buildAnalysisBars,
  FYERS_ADJUSTMENT_STATE,
} from "./analysis-bars.js";

test("FYERS provider-adjusted OHLCV passes through exactly once", () => {
  const bars = [{ date: "2026-09-11", open: 100, high: 110, low: 90, close: 105, volume: 2000 }];
  const series = buildAnalysisBars({
    bars,
    provider: "fyers",
    interval: "1d",
    asOfTimestamp: "2026-09-11T10:00:00.000Z",
  });
  assert.deepEqual(series.bars, bars);
  assert.notEqual(series.bars, bars);
  assert.equal(series.adjustmentState, FYERS_ADJUSTMENT_STATE);
  assert.equal(series.algorithmVersion, ANALYSIS_SERIES_VERSION);
  assert.match(series.provenance.claim, /adjusted/i);
});

test("analysisBars never silently assumes an unknown provider adjustment policy", () => {
  assert.throws(
    () => buildAnalysisBars({ bars: [], provider: "unknown", interval: "1d", asOfTimestamp: "2026-09-11T10:00:00.000Z" }),
    /No verified adjustment policy/
  );
});

test("analysisBars requires the frozen cutoff", () => {
  assert.throws(() => buildAnalysisBars({ bars: [], provider: "fyers", interval: "1d", asOfTimestamp: null }), /asOfTimestamp/);
});

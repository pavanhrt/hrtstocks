import { test } from "node:test";
import assert from "node:assert/strict";
import { getPublishedRunMetadata } from "./run-metadata.ts";

test("run metadata reports actual providers and never invents a legacy cutoff", () => {
  const metadata = getPublishedRunMetadata({
    run_date: "2026-09-10",
    status: "completed",
    completed_at: "2026-09-11T10:11:16Z",
    providers: { ohlcv: "fyers", universe: "nse_archives" },
  });

  assert.equal(metadata.cutoff, null);
  assert.deepEqual(metadata.providers, [
    { category: "ohlcv", provider: "fyers" },
    { category: "universe", provider: "nse_archives" },
  ]);
  assert.equal(metadata.publicationState, "COMPLETED (legacy lifecycle)");
});

test("run metadata consumes forward snapshot columns when present", () => {
  const metadata = getPublishedRunMetadata({
    run_date: "2026-09-11",
    status: "completed",
    as_of_timestamp: "2026-09-11T10:00:00Z",
    publication_state: "PUBLISHED",
    analysis_adjustment_state: "provider_adjusted",
    analysis_series_version: "fyers-v1",
    analysis_provider: "fyers",
  });

  assert.equal(metadata.cutoff, "2026-09-11T10:00:00Z");
  assert.equal(metadata.publicationState, "PUBLISHED");
  assert.equal(metadata.adjustmentState, "provider_adjusted");
  assert.equal(metadata.analysisSeriesVersion, "fyers-v1");
  assert.equal(metadata.analysisProvider, "fyers");
});

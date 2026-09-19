// Shared with services/pipeline/src/fome-analysis/index.js's STAGES constant
// (kept in sync by hand -- the Edge Function is Deno-only and cannot import
// from this Next.js app, so this is a deliberate, disclosed duplication of
// the stage *labels* only, not of any authoritative logic). Stage 7
// ("Retrieving news") is written by the polling API route
// (app/api/fome-analysis/[runId]/route.ts), not the Edge Function -- see
// that route's own header comment.
export const FOME_STAGES: { key: string; label: string }[] = [
  { key: "resolving_instrument", label: "Resolving instrument" },
  { key: "checking_cached_data", label: "Checking cached data" },
  { key: "refreshing_daily_data", label: "Refreshing daily data" },
  { key: "refreshing_15m_data", label: "Refreshing 15-minute data" },
  { key: "building_timeframes", label: "Building timeframes" },
  { key: "retrieving_derivative_information", label: "Retrieving derivative information" },
  { key: "retrieving_news", label: "Retrieving news" },
  { key: "applying_fome_rules", label: "Applying FOME rules" },
  { key: "comparing_strategies", label: "Comparing strategies" },
  { key: "saving_and_presenting_result", label: "Saving and presenting result" },
];

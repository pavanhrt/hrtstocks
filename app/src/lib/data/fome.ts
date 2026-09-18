import { createClient } from "@/lib/supabase/server";

export type InstrumentSearchResult = {
  id: string;
  symbol: string;
  name: string | null;
  exchange: string;
  isIndex: boolean;
};

/**
 * Symbol/name/id search over the `instruments` table for the /fome page's
 * autocomplete -- a plain server-side ilike query (never a live provider
 * call), so "don't call a provider on every keystroke" is satisfied
 * structurally (this only ever touches Supabase, never Fyers).
 */
export async function searchInstruments(query: string, limit = 20): Promise<InstrumentSearchResult[]> {
  const trimmed = query.trim();
  if (trimmed.length === 0) return [];
  const supabase = await createClient();
  const { data, error } = await supabase
    .from("instruments")
    .select("id, symbol, name, exchange, is_index")
    .or(`symbol.ilike.%${trimmed}%,name.ilike.%${trimmed}%,id.ilike.%${trimmed}%`)
    .order("is_index", { ascending: false })
    .order("symbol", { ascending: true })
    .limit(limit);
  if (error) throw error;
  return (data ?? []).map((r) => ({ id: r.id, symbol: r.symbol, name: r.name, exchange: r.exchange, isIndex: r.is_index }));
}

export type InstrumentFomeSummary = {
  id: string;
  symbol: string;
  name: string | null;
  exchange: string;
  isIndex: boolean;
  derivativeEligible: boolean | null;
  derivativeSource: string | null;
  lastAnalysisAt: string | null;
  lastAnalysisStatus: string | null;
  dataFreshness: string | null;
};

/**
 * Everything the selection panel needs to show before the user clicks
 * "Analyze latest data": classification, exchange, best-known derivative
 * eligibility (from this instrument's most recent FOME run, if any -- there
 * is no separate always-current eligibility flag; see the implementation
 * report's disclosed limitation), and when/how fresh the last analysis was.
 */
export async function getInstrumentFomeSummary(instrumentId: string): Promise<InstrumentFomeSummary | null> {
  const supabase = await createClient();
  const { data: instrument, error } = await supabase
    .from("instruments")
    .select("id, symbol, name, exchange, is_index")
    .eq("id", instrumentId)
    .maybeSingle();
  if (error) throw error;
  if (!instrument) return null;

  const { data: lastRun } = await supabase
    .from("fome_analysis_runs")
    .select("status, derivative_eligible, derivative_source, completed_at, data_quality")
    .eq("instrument_id", instrumentId)
    .order("created_at", { ascending: false })
    .limit(1)
    .maybeSingle();

  return {
    id: instrument.id,
    symbol: instrument.symbol,
    name: instrument.name,
    exchange: instrument.exchange,
    isIndex: instrument.is_index,
    derivativeEligible: lastRun?.derivative_eligible ?? null,
    derivativeSource: lastRun?.derivative_source ?? null,
    lastAnalysisAt: lastRun?.completed_at ?? null,
    lastAnalysisStatus: lastRun?.status ?? null,
    dataFreshness: lastRun?.data_quality ?? null,
  };
}

export type FomeTimeframeRow = {
  timeframe: "monthly" | "weekly" | "daily" | "15m";
  latestCompletedCandleAt: string | null;
  freshness: string | null;
  isProvisional: boolean;
  dowState: string | null;
  pivotSequence: string[] | null;
  macdState: string | null;
  rsi: number | null;
  adx: number | null;
  adxSlope: string | null;
  bollingerState: string | null;
  bollingerPriceLocation: string | null;
  support: number | null;
  resistance: number | null;
  breakoutState: string | null;
  direction: string | null;
  confidence: string;
  explanation: string | null;
  reusedFromRunId: string | null;
  chartObjectPath: string | null;
  chartContentHash: string | null;
  chartUrl: string | null;
};

export type FomeRuleTrace = {
  id: number;
  ruleId: string;
  ruleVersion: string | null;
  timeframe: string | null;
  observedValues: Record<string, unknown> | null;
  thresholds: Record<string, unknown> | null;
  result: string;
  sourceStatus: string | null;
  dataSource: string | null;
  sourceDocument: string | null;
  sourceLocator: string | null;
  explanation: string | null;
};

export type FomeStrategyCandidate = {
  rank: number;
  strategyId: string;
  qualificationStatus: string;
  whyFits: string | null;
  whyFails: string | null;
  legs: unknown[];
  lotSize: number | null;
  netDebitOrCredit: number | null;
  breakEvens: number[] | null;
  maxProfit: number | null;
  maxLoss: number | null;
  marginState: string;
  margin: number | null;
  rewardRisk: number | null;
  unlimitedRisk: boolean;
  roiPct: number | null;
  finalClassification: string | null;
};

export type FomeNewsItem = {
  id: number;
  headline: string;
  source: string | null;
  publishedAt: string | null;
  url: string | null;
  eventCategory: string | null;
  relevance: string | null;
  confidence: string | null;
  explanation: string | null;
};

export type FomeAnalysisResult = {
  id: string;
  instrumentId: string;
  status: string;
  asOfTimestamp: string;
  currentStage: string | null;
  stageHistory: { stage: string; at: string }[];
  finalAlignment: string | null;
  alignmentReason: string | null;
  underlyingAlignment: string | null;
  derivativeEligible: boolean | null;
  derivativeSource: string | null;
  selectedExpiry: string | null;
  spotDerivativeAligned: boolean | null;
  spotDerivativeSkewReason: string | null;
  newsRelevance: string | null;
  algorithmVersion: string | null;
  ruleVersion: string | null;
  parameterVersion: string | null;
  dataQuality: string | null;
  errorMessage: string | null;
  startedAt: string | null;
  completedAt: string | null;
  timeframes: Record<string, FomeTimeframeRow>;
  ruleTraces: FomeRuleTrace[];
  strategyCandidates: FomeStrategyCandidate[];
  news: FomeNewsItem[];
};

/** Full nested fetch for one FOME analysis run -- backs both the polling API route and any future direct-link view. */
export async function getFomeAnalysisResult(runId: string): Promise<FomeAnalysisResult | null> {
  const supabase = await createClient();
  const { data: run, error } = await supabase.from("fome_analysis_runs").select("*").eq("id", runId).maybeSingle();
  if (error) throw error;
  if (!run) return null;

  const [{ data: timeframeRows }, { data: ruleTraceRows }, { data: candidateRows }, { data: newsRows }] = await Promise.all([
    supabase.from("fome_timeframe_results").select("*").eq("analysis_run_id", runId),
    supabase.from("fome_rule_traces").select("*").eq("analysis_run_id", runId).order("rule_id", { ascending: true }),
    supabase.from("fome_strategy_candidates").select("*").eq("analysis_run_id", runId).order("rank", { ascending: true }),
    supabase.from("fome_news_items").select("*").eq("analysis_run_id", runId).order("published_at", { ascending: false }),
  ]);

  const chartPaths = (timeframeRows ?? []).map((r) => r.chart_object_path).filter((p): p is string => Boolean(p));
  const signedUrlByPath = new Map<string, string>();
  if (chartPaths.length > 0) {
    const { data: signed } = await supabase.storage.from("direction-charts").createSignedUrls(chartPaths, 60 * 60);
    for (const s of signed ?? []) if (s.path && s.signedUrl) signedUrlByPath.set(s.path, s.signedUrl);
  }

  const timeframes: Record<string, FomeTimeframeRow> = {};
  for (const r of timeframeRows ?? []) {
    timeframes[r.timeframe] = {
      timeframe: r.timeframe as FomeTimeframeRow["timeframe"],
      latestCompletedCandleAt: r.latest_completed_candle_at,
      freshness: r.freshness,
      isProvisional: r.is_provisional,
      dowState: r.dow_state,
      pivotSequence: r.pivot_sequence,
      macdState: r.macd_state,
      rsi: r.rsi,
      adx: r.adx,
      adxSlope: r.adx_slope,
      bollingerState: r.bollinger_state,
      bollingerPriceLocation: r.bollinger_price_location,
      support: r.support,
      resistance: r.resistance,
      breakoutState: r.breakout_state,
      direction: r.direction,
      confidence: r.confidence,
      explanation: r.explanation,
      reusedFromRunId: r.reused_from_run_id,
      chartObjectPath: r.chart_object_path,
      chartContentHash: r.chart_content_hash,
      chartUrl: r.chart_object_path ? (signedUrlByPath.get(r.chart_object_path) ?? null) : null,
    };
  }

  return {
    id: run.id,
    instrumentId: run.instrument_id,
    status: run.status,
    asOfTimestamp: run.as_of_timestamp,
    currentStage: run.current_stage,
    stageHistory: (run.stage_history as { stage: string; at: string }[]) ?? [],
    finalAlignment: run.final_alignment,
    alignmentReason: run.alignment_reason,
    underlyingAlignment: run.underlying_alignment,
    derivativeEligible: run.derivative_eligible,
    derivativeSource: run.derivative_source,
    selectedExpiry: run.selected_expiry,
    spotDerivativeAligned: run.spot_derivative_aligned,
    spotDerivativeSkewReason: run.spot_derivative_skew_reason,
    newsRelevance: run.news_relevance,
    algorithmVersion: run.algorithm_version,
    ruleVersion: run.rule_version,
    parameterVersion: run.parameter_version,
    dataQuality: run.data_quality,
    errorMessage: run.error_message,
    startedAt: run.started_at,
    completedAt: run.completed_at,
    timeframes,
    ruleTraces: (ruleTraceRows ?? []).map((t) => ({
      id: t.id,
      ruleId: t.rule_id,
      ruleVersion: t.rule_version,
      timeframe: t.timeframe,
      observedValues: t.observed_values as Record<string, unknown> | null,
      thresholds: t.thresholds as Record<string, unknown> | null,
      result: t.result,
      sourceStatus: t.source_status,
      dataSource: t.data_source,
      sourceDocument: t.source_document,
      sourceLocator: t.source_locator,
      explanation: t.explanation,
    })),
    strategyCandidates: (candidateRows ?? []).map((c) => ({
      rank: c.rank,
      strategyId: c.strategy_id,
      qualificationStatus: c.qualification_status,
      whyFits: c.why_fits,
      whyFails: c.why_fails,
      legs: (c.legs as unknown[]) ?? [],
      lotSize: c.lot_size,
      netDebitOrCredit: c.net_debit_or_credit,
      breakEvens: c.break_evens,
      maxProfit: c.max_profit,
      maxLoss: c.max_loss,
      marginState: c.margin_state,
      margin: c.margin,
      rewardRisk: c.reward_risk,
      unlimitedRisk: c.unlimited_risk,
      roiPct: c.roi_pct,
      finalClassification: c.final_classification,
    })),
    news: (newsRows ?? []).map((n) => ({
      id: n.id,
      headline: n.headline,
      source: n.source,
      publishedAt: n.published_at,
      url: n.url,
      eventCategory: n.event_category,
      relevance: n.relevance,
      confidence: n.confidence,
      explanation: n.explanation,
    })),
  };
}

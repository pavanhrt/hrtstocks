import { currentViewer } from "../access.ts";
import { chartUrl } from "../charts.ts";
import { getDb } from "../db/pool.ts";
import type { Tables } from "../database.types.ts";

const LIKE_ESCAPE = "\\";

/** Escapes LIKE/ILIKE wildcards so user input is matched literally (paired with `escape $2` in the SQL). */
export function escapeLike(input: string): string {
  return input.replace(/[\\%_]/g, (c) => LIKE_ESCAPE + c);
}

export type InstrumentSearchResult = {
  id: string;
  symbol: string;
  name: string | null;
  exchange: string;
  isIndex: boolean;
};

/**
 * Symbol/name/id search over the `instruments` table for the /fome page's
 * autocomplete -- a plain server-side, parameterized ilike query (never a live
 * provider call), so "don't call a provider on every keystroke" is satisfied
 * structurally (this only ever touches our own database, never Fyers).
 */
export async function searchInstruments(query: string, limit = 20): Promise<InstrumentSearchResult[]> {
  const trimmed = query.trim();
  if (trimmed.length === 0) return [];
  await currentViewer();
  const pattern = `%${escapeLike(trimmed.slice(0, 64))}%`;
  const rows = await getDb().query<{ id: string; symbol: string; name: string | null; exchange: string; is_index: boolean }>(
    `select id, symbol, name, exchange, is_index
       from instruments
      where symbol ilike $1 escape $2 or name ilike $1 escape $2 or id ilike $1 escape $2
      order by is_index desc, symbol asc
      limit $3`,
    [pattern, LIKE_ESCAPE, Math.max(1, Math.min(50, Math.trunc(limit)))],
  );
  return rows.map((r) => ({ id: r.id, symbol: r.symbol, name: r.name, exchange: r.exchange, isIndex: r.is_index }));
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
  await currentViewer();
  const db = getDb();
  const instrument = await db.one<{ id: string; symbol: string; name: string | null; exchange: string; is_index: boolean }>(
    `select id, symbol, name, exchange, is_index from instruments where id = $1`,
    [instrumentId],
  );
  if (!instrument) return null;

  const lastRun = await db.one<Pick<Tables<"fome_analysis_runs">, "status" | "derivative_eligible" | "derivative_source" | "completed_at" | "data_quality">>(
    `select status, derivative_eligible, derivative_source, completed_at, data_quality
       from fome_analysis_runs
      where instrument_id = $1
      order by created_at desc
      limit 1`,
    [instrumentId],
  );

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
  await currentViewer();
  const db = getDb();
  const run = await db.one<Tables<"fome_analysis_runs">>(`select * from fome_analysis_runs where id = $1`, [runId]);
  if (!run) return null;

  const [timeframeRows, ruleTraceRows, candidateRows, newsRows] = await Promise.all([
    db.query<Tables<"fome_timeframe_results">>(`select * from fome_timeframe_results where analysis_run_id = $1`, [runId]),
    db.query<Tables<"fome_rule_traces">>(`select * from fome_rule_traces where analysis_run_id = $1 order by rule_id asc`, [runId]),
    db.query<Tables<"fome_strategy_candidates">>(`select * from fome_strategy_candidates where analysis_run_id = $1 order by rank asc`, [runId]),
    db.query<Tables<"fome_news_items">>(`select * from fome_news_items where analysis_run_id = $1 order by published_at desc`, [runId]),
  ]);

  const timeframes: Record<string, FomeTimeframeRow> = {};
  for (const r of timeframeRows) {
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
      chartUrl: r.chart_object_path ? chartUrl(r.chart_object_path) : null,
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
    ruleTraces: ruleTraceRows.map((t) => ({
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
    strategyCandidates: candidateRows.map((c) => ({
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
    news: newsRows.map((n) => ({
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

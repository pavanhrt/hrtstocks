import { createClient } from "@/lib/supabase/server";
import { getLatestPublishedRun } from "@/lib/data/runs";
import { overallStatusFor } from "@/lib/data/buy-setup-status";

export { overallStatusFor } from "@/lib/data/buy-setup-status";

// All authoritative computation (the three-timeframe gate, daily/15-minute
// indicators, chart-structure detection, GUE wave, divergence) happens in
// supabase/functions/analyze-buy-setup/ and supabase/functions/run-screening/
// -- this file only reads already-persisted evidence and never calculates a
// pass/fail/technical condition itself (AGENTS.md: "the UI must not
// calculate authoritative signals").
//
// Real server-side pagination: the main table reads from
// buy_setup_analysis_ledger (migration 0011, a `security_invoker` view
// joining the run ledger with BSP-M1/BSP-M3/BSA-D1/BSA-G1 gate results, the
// 15-minute wave, and divergence results) via ordinary PostgREST
// .eq()/.order()/.range() -- filtering, sorting, and pagination all happen
// in Postgres. Only the CURRENT PAGE's instrument ids are then used to fetch
// the richer per-instrument detail tables (patterns, EMA crossover, chart
// levels, charts) and to sign chart URLs -- never the whole universe's.

export const BUY_SETUP_PAGE_SIZE = 25;

export type BuySetupManifest = {
  runId: string;
  enrichmentState: "pending" | "processing" | "validated" | "validation_failed" | "published" | null;
  qualifiedCount: number;
  fifteenMinuteCompletedCount: number;
  manualReviewCount: number;
  noDataCount: number;
  expectedEquityCount: number;
  ruleVersion: string | null;
  parameterVersion: string | null;
  validationErrors: string[];
  validatedAt: string | null;
  publishedAt: string | null;
};

export async function getBuySetupManifest(runId: string): Promise<BuySetupManifest | null> {
  const supabase = await createClient();
  const { data, error } = await supabase
    .from("buy_setup_manifests")
    .select("*")
    .eq("run_id", runId)
    .maybeSingle();
  if (error) {
    if (error.code === "PGRST205" || error.code === "42703") return null;
    throw error;
  }
  if (!data) return null;
  const row = data as unknown as {
    run_id: string;
    enrichment_state: BuySetupManifest["enrichmentState"];
    qualified_count: number;
    fifteen_minute_completed_count: number;
    manual_review_count: number;
    no_data_count: number;
    expected_equity_count: number;
    rule_version: string | null;
    parameter_version: string | null;
    validation_errors: string[] | null;
    validated_at: string | null;
    published_at: string | null;
  };
  return {
    runId: row.run_id,
    enrichmentState: row.enrichment_state,
    qualifiedCount: row.qualified_count,
    fifteenMinuteCompletedCount: row.fifteen_minute_completed_count,
    manualReviewCount: row.manual_review_count,
    noDataCount: row.no_data_count,
    expectedEquityCount: row.expected_equity_count,
    ruleVersion: row.rule_version,
    parameterVersion: row.parameter_version,
    validationErrors: row.validation_errors ?? [],
    validatedAt: row.validated_at,
    publishedAt: row.published_at,
  };
}

export type BuySetupRow = {
  instrumentId: string;
  symbol: string;
  name: string;
  monthly: { dowState: string | null; breakoutUpWithVolume: boolean | null; result: string };
  weekly: { dowState: string | null; breakoutUpWithVolume: boolean | null; result: string };
  daily: { dowState: string | null; breakoutUpWithVolume: boolean | null; result: string };
  threeTimeframeGate: string;
  qualified: boolean;
  candlestickPatterns: { name: string; direction: string; state: string }[];
  dailyEmaCrossover: { status: string; slowPeriod: number } | null;
  chartPatterns: { name: string; direction: string; state: string }[];
  support: number | null;
  resistance: number | null;
  breakoutStatus: string;
  channelType: string | null;
  fifteenMinEmaCrossover: string | null;
  fifteenMinRsi: number | null;
  fifteenMinStochastic: { k: number | null; d: number | null } | null;
  fifteenMinBollingerStatus: string | null;
  fifteenMinPlusDi: number | null;
  fifteenMinMinusDi: number | null;
  fifteenMinAdx: number | null;
  fifteenMinWave: string | null;
  rsiBullishReversal: string | null;
  macdBullishReversal: string | null;
  overallStatus: string;
  evidenceTimestamp: string | null;
  dailyChartUrl: string | null;
  fifteenMinChartUrl: string | null;
};

export type BuySetupFilters = {
  page?: number;
  pageSize?: number;
  query?: string;
  monthlyState?: string;
  weeklyState?: string;
  dailyState?: string;
  gate?: "all" | "PASS" | "FAIL" | "NO_DATA";
  wave?: string;
  reversal?: "all" | "rsi_pass" | "macd_pass" | "either_pass" | "none";
  overallStatus?: string;
  dataAvailability?: "all" | "has_data" | "no_data";
  sortBy?: "symbol" | "overall_status" | "gate_result";
  sortDirection?: "asc" | "desc";
};

export type BuySetupPageResult = {
  runId: string;
  runDate: string;
  manifest: BuySetupManifest | null;
  patternCoverage: { candlestickImplemented: string[]; candlestickNotEvaluated: string[]; chartPatternImplemented: string[]; chartPatternNotEvaluated: string[] } | null;
  rows: BuySetupRow[];
  totalCount: number;
  page: number;
  pageCount: number;
  pageSize: number;
  summary: {
    totalEquities: number;
    monthlyBullish: number;
    weeklyBullish: number;
    dailyBullish: number;
    threeTimeframeQualified: number;
    fifteenMinCompleted: number;
    manualReview: number;
    noData: number;
  };
};

type LedgerRow = {
  instrument_id: string;
  symbol: string;
  name: string | null;
  monthly_result: string | null;
  monthly_dow_state: string | null;
  monthly_breakout_up_with_volume: boolean | null;
  weekly_result: string | null;
  weekly_dow_state: string | null;
  weekly_breakout_up_with_volume: boolean | null;
  daily_result: string | null;
  daily_dow_state: string | null;
  daily_breakout_up_with_volume: boolean | null;
  gate_result: string | null;
  qualified: boolean;
  fifteen_min_wave: string | null;
  rsi_reversal_result: string | null;
  macd_reversal_result: string | null;
  has_intraday_indicators: boolean;
  overall_status: string;
  evidence_timestamp: string | null;
};

/** Counts matching `applyFilters`, via a bounded head-only query -- never loads rows just to count them. */
async function countLedger(supabase: Awaited<ReturnType<typeof createClient>>, runId: string, apply: (q: ReturnType<typeof supabase.from>) => ReturnType<typeof supabase.from>) {
  let query = supabase.from("buy_setup_analysis_ledger").select("run_id", { count: "exact", head: true }).eq("run_id", runId) as unknown as ReturnType<typeof supabase.from>;
  query = apply(query);
  const { count, error } = (await query) as unknown as { count: number | null; error: { code: string } | null };
  if (error) {
    if (error.code === "PGRST205" || error.code === "42703") return 0;
    throw error;
  }
  return count ?? 0;
}

export async function getBuySetupAnalysisPage(filters: BuySetupFilters = {}): Promise<BuySetupPageResult | null> {
  const run = await getLatestPublishedRun();
  if (!run) return null;
  const supabase = await createClient();
  const manifest = await getBuySetupManifest(run.id);

  const { data: coverageRow } = await supabase
    .from("buy_setup_pattern_detector_coverage")
    .select("*")
    .eq("run_id", run.id)
    .maybeSingle();
  const patternCoverage = coverageRow
    ? {
        candlestickImplemented: (coverageRow as unknown as { candlestick_implemented: string[] }).candlestick_implemented ?? [],
        candlestickNotEvaluated: (coverageRow as unknown as { candlestick_not_evaluated: string[] }).candlestick_not_evaluated ?? [],
        chartPatternImplemented: (coverageRow as unknown as { chart_pattern_implemented: string[] }).chart_pattern_implemented ?? [],
        chartPatternNotEvaluated: (coverageRow as unknown as { chart_pattern_not_evaluated: string[] }).chart_pattern_not_evaluated ?? [],
      }
    : null;

  const normalizedQuery = (filters.query ?? "").trim();

  function applyFilters<T>(query: T): T {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    let q = query as any;
    if (normalizedQuery) q = q.or(`symbol.ilike.%${normalizedQuery}%,name.ilike.%${normalizedQuery}%,instrument_id.ilike.%${normalizedQuery}%`);
    if (filters.monthlyState && filters.monthlyState !== "all") q = q.eq("monthly_dow_state", filters.monthlyState);
    if (filters.weeklyState && filters.weeklyState !== "all") q = q.eq("weekly_dow_state", filters.weeklyState);
    if (filters.dailyState && filters.dailyState !== "all") q = q.eq("daily_dow_state", filters.dailyState);
    if (filters.gate && filters.gate !== "all") q = q.eq("gate_result", filters.gate);
    if (filters.wave && filters.wave !== "all") q = q.eq("fifteen_min_wave", filters.wave);
    if (filters.reversal === "rsi_pass") q = q.eq("rsi_reversal_result", "PASS");
    if (filters.reversal === "macd_pass") q = q.eq("macd_reversal_result", "PASS");
    if (filters.reversal === "either_pass") q = q.or("rsi_reversal_result.eq.PASS,macd_reversal_result.eq.PASS");
    if (filters.reversal === "none") q = q.not("rsi_reversal_result", "eq", "PASS").not("macd_reversal_result", "eq", "PASS");
    if (filters.overallStatus && filters.overallStatus !== "all") q = q.eq("overall_status", filters.overallStatus);
    if (filters.dataAvailability === "has_data") q = q.not("overall_status", "eq", "NO_DATA");
    if (filters.dataAvailability === "no_data") q = q.eq("overall_status", "NO_DATA");
    return q as T;
  }

  const totalCount = await countLedger(supabase, run.id, (q) => applyFilters(q));
  const pageSize = Math.max(1, Math.min(100, filters.pageSize ?? BUY_SETUP_PAGE_SIZE));
  const pageCount = Math.max(1, Math.ceil(totalCount / pageSize));
  const page = Math.min(Math.max(1, filters.page ?? 1), pageCount);

  const sortColumn = filters.sortBy === "overall_status" ? "overall_status" : filters.sortBy === "gate_result" ? "gate_result" : "symbol";
  const ascending = (filters.sortDirection ?? "asc") === "asc";

  let listQuery = supabase.from("buy_setup_analysis_ledger").select("*").eq("run_id", run.id) as unknown as ReturnType<typeof supabase.from>;
  listQuery = applyFilters(listQuery);
  // Deterministic sort with a stable tie-breaker (instrument_id) -- two rows
  // that compare equal on the requested column must still land in a fixed
  // order across pages, never re-shuffling between requests.
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  listQuery = (listQuery as any).order(sortColumn, { ascending }).order("instrument_id", { ascending: true }).range((page - 1) * pageSize, page * pageSize - 1);
  const { data: ledgerRows, error: ledgerError } = (await listQuery) as unknown as { data: LedgerRow[] | null; error: { code: string; message: string } | null };
  if (ledgerError && ledgerError.code !== "PGRST205" && ledgerError.code !== "42703") throw ledgerError;
  const pageRows = ledgerRows ?? [];
  const qualifiedIds = pageRows.filter((r) => r.qualified).map((r) => r.instrument_id);

  const [
    { data: candlestickDetections },
    { data: chartPatternDetections },
    { data: dailyEma },
    { data: chartLevels },
    { data: intradayIndicators },
    { data: charts },
  ] = qualifiedIds.length > 0
    ? await Promise.all([
        supabase.from("buy_setup_candlestick_detections").select("*").eq("run_id", run.id).in("instrument_id", qualifiedIds),
        supabase.from("buy_setup_chart_pattern_detections").select("*").eq("run_id", run.id).in("instrument_id", qualifiedIds),
        supabase.from("buy_setup_ema_crossover").select("*").eq("run_id", run.id).eq("timeframe", "daily").in("instrument_id", qualifiedIds),
        supabase.from("buy_setup_chart_levels").select("*").eq("run_id", run.id).in("instrument_id", qualifiedIds),
        supabase.from("buy_setup_intraday_indicators").select("*").eq("run_id", run.id).in("instrument_id", qualifiedIds),
        supabase.from("buy_setup_charts").select("*").eq("run_id", run.id).in("instrument_id", qualifiedIds),
      ])
    : [{ data: [] }, { data: [] }, { data: [] }, { data: [] }, { data: [] }, { data: [] }];

  type AnyRow = Record<string, unknown> & { instrument_id: string };
  const groupBy = (rows: AnyRow[] | null | undefined) => {
    const map = new Map<string, AnyRow[]>();
    for (const row of rows ?? []) {
      const list = map.get(row.instrument_id) ?? [];
      list.push(row);
      map.set(row.instrument_id, list);
    }
    return map;
  };
  const candlestickByInstrument = groupBy(candlestickDetections as unknown as AnyRow[] | null);
  const chartPatternByInstrument = groupBy(chartPatternDetections as unknown as AnyRow[] | null);
  const dailyEmaByInstrument = groupBy(dailyEma as unknown as AnyRow[] | null);
  const chartLevelsByInstrument = new Map((chartLevels as unknown as AnyRow[] | null ?? []).map((r) => [r.instrument_id, r]));
  const intradayByInstrument = new Map((intradayIndicators as unknown as AnyRow[] | null ?? []).map((r) => [r.instrument_id, r]));
  const chartByInstrumentTimeframe = new Map<string, string>();
  for (const row of (charts as unknown as AnyRow[] | null) ?? []) chartByInstrumentTimeframe.set(`${row.instrument_id}:${row.timeframe}`, row.chart_object_path as string);

  // Sign chart URLs ONLY for this page's rows.
  const chartPaths = [...chartByInstrumentTimeframe.values()];
  const signedUrlByPath = new Map<string, string>();
  if (chartPaths.length > 0) {
    const { data: signed } = await supabase.storage.from("direction-charts").createSignedUrls(chartPaths, 60 * 60);
    for (const s of signed ?? []) if (s.path && s.signedUrl) signedUrlByPath.set(s.path, s.signedUrl);
  }

  const rows: BuySetupRow[] = pageRows.map((entry) => {
    const na = !entry.qualified;
    const levels = chartLevelsByInstrument.get(entry.instrument_id);
    const intraday = intradayByInstrument.get(entry.instrument_id);
    const dailyEmaRows = dailyEmaByInstrument.get(entry.instrument_id) ?? [];
    const triggeredDailyEma = dailyEmaRows.find((r) => r.status === "TRIGGERED") ?? dailyEmaRows[0];
    const dailyChartPath = chartByInstrumentTimeframe.get(`${entry.instrument_id}:daily`);
    const fifteenMinChartPath = chartByInstrumentTimeframe.get(`${entry.instrument_id}:15m`);

    return {
      instrumentId: entry.instrument_id,
      symbol: entry.symbol,
      name: entry.name ?? entry.symbol,
      monthly: { dowState: entry.monthly_dow_state, breakoutUpWithVolume: entry.monthly_breakout_up_with_volume, result: entry.monthly_result ?? "NO_DATA" },
      weekly: { dowState: entry.weekly_dow_state, breakoutUpWithVolume: entry.weekly_breakout_up_with_volume, result: entry.weekly_result ?? "NO_DATA" },
      daily: { dowState: entry.daily_dow_state, breakoutUpWithVolume: entry.daily_breakout_up_with_volume, result: entry.daily_result ?? "NO_DATA" },
      threeTimeframeGate: entry.gate_result ?? "NO_DATA",
      qualified: entry.qualified,
      candlestickPatterns: na ? [] : (candlestickByInstrument.get(entry.instrument_id) ?? []).map((p) => ({ name: p.pattern_name as string, direction: p.direction as string, state: p.state as string })),
      dailyEmaCrossover: na ? null : triggeredDailyEma ? { status: triggeredDailyEma.status as string, slowPeriod: triggeredDailyEma.slow_period as number } : null,
      chartPatterns: na ? [] : (chartPatternByInstrument.get(entry.instrument_id) ?? []).map((p) => ({ name: p.pattern_name as string, direction: p.direction as string, state: p.state as string })),
      support: na ? null : (levels?.support_level as number) ?? null,
      resistance: na ? null : (levels?.resistance_level as number) ?? null,
      breakoutStatus: na ? "NOT_APPLICABLE" : levels?.breakout_detected == null ? "NO_DATA" : levels.breakout_detected ? (levels.breakout_volume_confirmed ? "CONFIRMED" : "PRICE_ONLY") : "NONE",
      channelType: na ? null : (levels?.channel_type as string) ?? null,
      fifteenMinEmaCrossover: na ? "NOT_APPLICABLE" : null, // filled below once 15m ema data is joined
      fifteenMinRsi: na ? null : (intraday?.rsi as number) ?? null,
      fifteenMinStochastic: na ? null : intraday ? { k: intraday.stochastic_k as number | null, d: intraday.stochastic_d as number | null } : null,
      fifteenMinBollingerStatus: na ? "NOT_APPLICABLE" : (intraday?.bollinger_status as string) ?? "NO_DATA",
      fifteenMinPlusDi: na ? null : (intraday?.plus_di as number) ?? null,
      fifteenMinMinusDi: na ? null : (intraday?.minus_di as number) ?? null,
      fifteenMinAdx: na ? null : (intraday?.adx as number) ?? null,
      fifteenMinWave: na ? "NOT_APPLICABLE" : entry.fifteen_min_wave ?? "NO_DATA",
      rsiBullishReversal: na ? "NOT_APPLICABLE" : entry.rsi_reversal_result ?? "NO_DATA",
      macdBullishReversal: na ? "NOT_APPLICABLE" : entry.macd_reversal_result ?? "NO_DATA",
      overallStatus: entry.overall_status ?? overallStatusFor(entry.gate_result ?? "NO_DATA", entry.qualified, entry.has_intraday_indicators ? "PASS" : "NO_DATA"),
      evidenceTimestamp: na ? null : entry.evidence_timestamp,
      dailyChartUrl: dailyChartPath ? signedUrlByPath.get(dailyChartPath) ?? null : null,
      fifteenMinChartUrl: fifteenMinChartPath ? signedUrlByPath.get(fifteenMinChartPath) ?? null : null,
    };
  });

  // Fill in the 15-minute EMA crossover column (needs its own per-instrument
  // fetch, same page-scoped id set).
  if (qualifiedIds.length > 0) {
    const { data: fifteenMinEma } = await supabase.from("buy_setup_ema_crossover").select("*").eq("run_id", run.id).eq("timeframe", "15m").in("instrument_id", qualifiedIds);
    const byInstrument = groupBy(fifteenMinEma as unknown as AnyRow[] | null);
    for (const row of rows) {
      if (!row.qualified) continue;
      const list = byInstrument.get(row.instrumentId) ?? [];
      const triggered = list.find((r) => r.status === "TRIGGERED") ?? list[0];
      row.fifteenMinEmaCrossover = triggered ? (triggered.status as string) : "NO_DATA";
    }
  }

  // Summary cards: prefer the RECONCILED, validated counts from
  // buy_setup_manifests once published (per publish_buy_setup_enrichment's
  // own transactional validation) -- only fall back to a live aggregate
  // query against the ledger view while enrichment is still processing or
  // has no manifest yet, so every card on the page is always drawn from ONE
  // consistent snapshot rather than mixing a published gate count with a
  // live-recomputed 15-minute count.
  const [totalEquities, monthlyBullish, weeklyBullish, dailyBullish] = await Promise.all([
    countLedger(supabase, run.id, (q) => q),
    countLedger(supabase, run.id, (q) => (q as unknown as { eq: (c: string, v: string) => unknown }).eq("monthly_result", "PASS") as unknown as ReturnType<typeof supabase.from>),
    countLedger(supabase, run.id, (q) => (q as unknown as { eq: (c: string, v: string) => unknown }).eq("weekly_result", "PASS") as unknown as ReturnType<typeof supabase.from>),
    countLedger(supabase, run.id, (q) => (q as unknown as { eq: (c: string, v: string) => unknown }).eq("daily_result", "PASS") as unknown as ReturnType<typeof supabase.from>),
  ]);

  const usePublishedManifestCounts = manifest?.enrichmentState === "published";
  const [threeTimeframeQualified, fifteenMinCompleted, manualReview, noData] = usePublishedManifestCounts
    ? [manifest.qualifiedCount, manifest.fifteenMinuteCompletedCount, manifest.manualReviewCount, manifest.noDataCount]
    : await Promise.all([
        countLedger(supabase, run.id, (q) => (q as unknown as { eq: (c: string, v: string) => unknown }).eq("gate_result", "PASS") as unknown as ReturnType<typeof supabase.from>),
        countLedger(supabase, run.id, (q) => (q as unknown as { eq: (c: string, v: string) => unknown }).eq("overall_status", "TECHNICAL_EVIDENCE_PRESENT") as unknown as ReturnType<typeof supabase.from>),
        countLedger(supabase, run.id, (q) => (q as unknown as { eq: (c: string, v: string) => unknown }).eq("overall_status", "MANUAL_REVIEW") as unknown as ReturnType<typeof supabase.from>),
        countLedger(supabase, run.id, (q) => (q as unknown as { eq: (c: string, v: string) => unknown }).eq("overall_status", "NO_DATA") as unknown as ReturnType<typeof supabase.from>),
      ]);

  return {
    runId: run.id,
    runDate: run.run_date,
    manifest,
    patternCoverage,
    rows,
    totalCount,
    page,
    pageCount,
    pageSize,
    summary: { totalEquities, monthlyBullish, weeklyBullish, dailyBullish, threeTimeframeQualified, fifteenMinCompleted, manualReview, noData },
  };
}

export type BuySetupConditionRow = {
  ruleId: string;
  stage: string;
  timeframe: string;
  requiredCondition: string;
  observedValue: string;
  result: string;
  explanation: string;
  evidenceTimestamp: string | null;
  dataQuality: string;
  ruleVersion: string | null;
  parameterVersion: string | null;
  sourceStatus: string | null;
  sourceLocator: string | null;
};

const REQUIRED_CONDITIONS: Record<string, string> = {
  "BSP-M1": "dow_state uptrend/reversal, or sideways with a volume-confirmed upside breakout (monthly)",
  "BSP-M3": "dow_state uptrend/reversal, or sideways with a volume-confirmed upside breakout (weekly)",
  "BSA-D1": "dow_state uptrend/reversal, or sideways with a volume-confirmed upside breakout (daily)",
  "BSA-G1": "monthly AND weekly AND daily bullish predicates all PASS",
};

/** Full condition table for one instrument's detail view/route -- every requested condition, not just the three-timeframe gate. */
export async function getBuySetupInstrumentDetail(instrumentId: string): Promise<{ conditions: BuySetupConditionRow[]; row: BuySetupRow | null; dailyChartUrl: string | null; fifteenMinChartUrl: string | null; patternCoverage: BuySetupPageResult["patternCoverage"] } | null> {
  const page = await getBuySetupAnalysisPage({ query: instrumentId, pageSize: 100 });
  if (!page) return null;
  const row = page.rows.find((r) => r.instrumentId === instrumentId) ?? null;
  const supabase = await createClient();

  const [{ data: gateTraces }, chartLevelsRes, intradayRes, waveRes, divergenceRes] = await Promise.all([
    supabase.from("rule_traces").select("*").eq("run_id", page.runId).eq("instrument_id", instrumentId).in("rule_id", ["BSP-M1", "BSP-M3"]),
    supabase.from("buy_setup_chart_levels").select("*").eq("run_id", page.runId).eq("instrument_id", instrumentId).maybeSingle(),
    supabase.from("buy_setup_intraday_indicators").select("*").eq("run_id", page.runId).eq("instrument_id", instrumentId).maybeSingle(),
    supabase.from("buy_setup_fifteen_minute_wave").select("*").eq("run_id", page.runId).eq("instrument_id", instrumentId).maybeSingle(),
    supabase.from("buy_setup_divergence_evidence").select("*").eq("run_id", page.runId).eq("instrument_id", instrumentId),
  ]);
  const { data: bsaTraces } = await supabase.from("buy_setup_gate_traces").select("*").eq("run_id", page.runId).eq("instrument_id", instrumentId);

  type AnyRow = Record<string, unknown>;
  const conditions: BuySetupConditionRow[] = [];

  for (const t of (gateTraces ?? []) as unknown as AnyRow[]) {
    conditions.push({
      ruleId: t.rule_id as string,
      stage: "timeframe_dow_check",
      timeframe: t.rule_id === "BSP-M1" ? "monthly" : "weekly",
      requiredCondition: REQUIRED_CONDITIONS[t.rule_id as string] ?? "",
      observedValue: JSON.stringify(t.observed_values ?? {}),
      result: t.result as string,
      explanation: (t.explanation as string) ?? "",
      evidenceTimestamp: null,
      dataQuality: t.result === "NO_DATA" ? "NO_DATA" : "PASS",
      ruleVersion: (t.rule_version as string) ?? null,
      parameterVersion: null,
      sourceStatus: "DOCUMENTED",
      sourceLocator: (t.source_locator as string) ?? "strategies/buy-signal-playbook.yaml",
    });
  }
  for (const t of (bsaTraces ?? []) as unknown as AnyRow[]) {
    conditions.push({
      ruleId: t.rule_id as string,
      stage: t.rule_id === "BSA-G1" ? "three_timeframe_gate" : "timeframe_dow_check",
      timeframe: t.rule_id === "BSA-D1" ? "daily" : "combined",
      requiredCondition: REQUIRED_CONDITIONS[t.rule_id as string] ?? "",
      observedValue: JSON.stringify(t.observed_values ?? {}),
      result: t.result as string,
      explanation: (t.explanation as string) ?? "",
      evidenceTimestamp: (t.computed_at as string) ?? null,
      dataQuality: t.result === "NO_DATA" ? "NO_DATA" : "PASS",
      ruleVersion: (t.rule_version as string) ?? null,
      parameterVersion: (t.parameter_version as string) ?? null,
      sourceStatus: (t.source_status as string) ?? "PROJECT_DEFAULT",
      sourceLocator: (t.source_locator as string) ?? "strategies/buy-setup-analysis.yaml decision record (2026-09-15)",
    });
  }

  if (row?.qualified) {
    const levels = chartLevelsRes.data as unknown as AnyRow | null;
    const intraday = intradayRes.data as unknown as AnyRow | null;
    const wave = waveRes.data as unknown as AnyRow | null;
    const divergences = (divergenceRes.data ?? []) as unknown as AnyRow[];

    const pushIndicator = (id: string, timeframe: string, label: string, observed: unknown, result: string | null, paramVersion: string | null, evidenceTs: string | null) => {
      conditions.push({
        ruleId: id,
        stage: "daily_or_15m_analysis",
        timeframe,
        requiredCondition: label,
        observedValue: JSON.stringify(observed ?? {}),
        result: result ?? "NO_DATA",
        explanation: "",
        evidenceTimestamp: evidenceTs,
        dataQuality: result ? "PASS" : "NO_DATA",
        ruleVersion: null,
        parameterVersion: paramVersion,
        sourceStatus: "PROJECT_DEFAULT",
        sourceLocator: "supabase/functions/run-screening/buy-setup/",
      });
    };

    pushIndicator("BSA-DAILY-EMA", "daily", "EMA 5 crosses above EMA 13 or 26 within the confirmation window", { dailyEmaCrossover: row.dailyEmaCrossover }, row.dailyEmaCrossover?.status ?? null, null, null);
    pushIndicator("BSA-DAILY-SUPPORT", "daily", "confirmed support level from fractal pivots", { support: row.support }, row.support != null ? "PASS" : "NO_DATA", (levels?.parameter_version as string) ?? null, null);
    pushIndicator("BSA-DAILY-RESISTANCE", "daily", "confirmed resistance level from fractal pivots", { resistance: row.resistance }, row.resistance != null ? "PASS" : "NO_DATA", (levels?.parameter_version as string) ?? null, null);
    pushIndicator("BSA-DAILY-BREAKOUT", "daily", "close clears resistance by the breakout buffer AND volume exceeds the trailing average", { breakoutStatus: row.breakoutStatus }, row.breakoutStatus, (levels?.parameter_version as string) ?? null, null);
    pushIndicator("BSA-DAILY-CHANNEL", "daily", "least-squares trendline through confirmed pivots", { channelType: row.channelType }, row.channelType, (levels?.parameter_version as string) ?? null, null);
    pushIndicator("BSA-15M-EMA", "15m", "EMA 5 crosses above EMA 13 or 26 within the confirmation window", { crossover: row.fifteenMinEmaCrossover }, row.fifteenMinEmaCrossover, null, (intraday?.evidence_candle_ts as string) ?? null);
    pushIndicator("BSA-15M-RSI", "15m", "RSI(14) reading", { rsi: intraday?.rsi, previous: intraday?.rsi_previous }, intraday ? "PASS" : "NO_DATA", (intraday?.parameter_version as string) ?? null, (intraday?.evidence_candle_ts as string) ?? null);
    pushIndicator("BSA-15M-STOCHASTIC", "15m", "Slow Stochastic %K/%D reading", { k: intraday?.stochastic_k, d: intraday?.stochastic_d }, intraday ? "PASS" : "NO_DATA", (intraday?.parameter_version as string) ?? null, (intraday?.evidence_candle_ts as string) ?? null);
    pushIndicator("BSA-15M-BOLLINGER", "15m", "close position relative to the upper/lower Bollinger Bands", { status: intraday?.bollinger_status }, (intraday?.bollinger_status as string) ?? "NO_DATA", (intraday?.parameter_version as string) ?? null, (intraday?.evidence_candle_ts as string) ?? null);
    pushIndicator("BSA-15M-DMI", "15m", "+DI, -DI, and ADX reading", { plusDi: intraday?.plus_di, minusDi: intraday?.minus_di, adx: intraday?.adx }, intraday ? "PASS" : "NO_DATA", (intraday?.parameter_version as string) ?? null, (intraday?.evidence_candle_ts as string) ?? null);
    pushIndicator("BSA-15M-MACD", "15m", "MACD line, signal, and histogram reading", { macd: intraday?.macd_line, signal: intraday?.macd_signal, histogram: intraday?.macd_histogram }, intraday ? "PASS" : "NO_DATA", (intraday?.parameter_version as string) ?? null, (intraday?.evidence_candle_ts as string) ?? null);
    pushIndicator(
      "BSA-15M-GUE-WAVE",
      "15m",
      "GUE-IMPULSE-001/002/003 Elliott validity rules against confirmed 15-minute pivots",
      { structureType: wave?.structure_type, currentWave: wave?.current_wave, confidence: wave?.confidence, ruleArithmetic: wave?.rule_arithmetic, ruleEvidence: wave?.rule_evidence, invalidationPrice: wave?.invalidation_price },
      wave ? (wave.confidence as string) : "NO_DATA",
      null,
      null
    );
    for (const d of divergences) {
      pushIndicator(
        d.indicator === "rsi" ? "BSA-15M-RSI-DIVERGENCE" : "BSA-15M-MACD-DIVERGENCE",
        "15m",
        "confirmed lower low in price AND confirmed higher low in the indicator",
        { pricePivot1: { ts: d.price_pivot_1_ts, value: d.price_pivot_1_value }, pricePivot2: { ts: d.price_pivot_2_ts, value: d.price_pivot_2_value }, indicatorPivot1: d.indicator_pivot_1_value, indicatorPivot2: d.indicator_pivot_2_value, reason: d.reason },
        d.result as string,
        (d.parameter_version as string) ?? null,
        null
      );
    }
  }

  conditions.push({
    ruleId: "OVERALL-STATUS",
    stage: "summary",
    timeframe: "combined",
    requiredCondition: "derived from the three-timeframe gate and 15-minute data availability -- see buy-setup-status.ts",
    observedValue: JSON.stringify({ gate: row?.threeTimeframeGate, qualified: row?.qualified }),
    result: row?.overallStatus ?? "NO_DATA",
    explanation: "",
    evidenceTimestamp: row?.evidenceTimestamp ?? null,
    dataQuality: row?.overallStatus === "NO_DATA" ? "NO_DATA" : "PASS",
    ruleVersion: null,
    parameterVersion: null,
    sourceStatus: "PROJECT_DEFAULT",
    sourceLocator: "app/src/lib/data/buy-setup-status.ts",
  });

  return { conditions, row, dailyChartUrl: row?.dailyChartUrl ?? null, fifteenMinChartUrl: row?.fifteenMinChartUrl ?? null, patternCoverage: page.patternCoverage };
}

import { currentViewer } from "../access.ts";
import { chartUrl } from "../charts.ts";
import { getDb } from "../db/pool.ts";
import { buySetupVisibleSql, isStaff } from "../db/visibility.ts";
import { getLatestPublishedRun } from "./runs.ts";
import { overallStatusFor } from "./buy-setup-status.ts";
import { buildSortSpecs } from "./buy-setup-sort.ts";
import { buildLedgerOrderBy, buildLedgerWhere } from "./buy-setup-ledger-sql.ts";

export { overallStatusFor } from "./buy-setup-status.ts";

// All authoritative computation (the three-timeframe gate, daily/15-minute
// indicators, chart-structure detection, GUE wave, divergence) happens in
// services/pipeline/src/analyze-buy-setup/ and services/pipeline/src/run-screening/
// -- this file only reads already-persisted evidence and never calculates a
// pass/fail/technical condition itself (AGENTS.md: "the UI must not
// calculate authoritative signals").
//
// Real server-side pagination: the main table reads from
// buy_setup_analysis_ledger (migration 0011, a view
// joining the run ledger with BSP-M1/BSP-M3/BSA-D1/BSA-G1 gate results, the
// 15-minute wave, and divergence results) via explicit parameterized SQL --
// filtering, sorting, and pagination all happen in Postgres. Only the CURRENT PAGE's instrument ids are then used to fetch
// the richer per-instrument detail tables (patterns, EMA crossover, chart
// levels, charts) and to build chart URLs -- never the whole universe's.

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
  const viewer = await currentViewer();
  const data = await getDb().one<Record<string, unknown>>(
    `select m.* from buy_setup_manifests m
      where m.run_id = $1 and (m.enrichment_state = 'published' or $2::boolean)`,
    [runId, isStaff(viewer)],
  );
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
  // Fundamental Analysis Score -- a completely independent research overlay
  // (fundamentals/fundamental-score.yaml). Computed from fundamental
  // evidence only; never derived from, and never influences, any field
  // above. See app/src/lib/data/fundamental-score.ts.
  fundamentalScore: {
    score: number | null;
    grade: string | null;
    coveragePercentage: number | null;
    dataStatus: "SCORED" | "NO_DATA" | "MANUAL_REVIEW" | "NOT_APPLICABLE";
    sectorModel: string | null;
    asOf: string | null;
  };
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
  sortBy?: "symbol" | "overall_status" | "gate_result" | "fundamental_score";
  sortDirection?: "asc" | "desc";
  // Fundamental Analysis Score filters -- independent of every technical
  // filter above; never affect which rows count toward the technical
  // summary cards or the three-timeframe gate.
  minFundamentalScore?: number;
  fundamentalDataStatus?: "all" | "SCORED" | "NO_DATA" | "MANUAL_REVIEW" | "NOT_APPLICABLE";
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
  fundamental_score: number | null;
  fundamental_grade: string | null;
  fundamental_coverage_percentage: number | null;
  fundamental_data_status: string | null;
  fundamental_sector_model: string | null;
  fundamental_as_of: string | null;
};

async function countLedger(runId: string, staff: boolean, filters: Parameters<typeof buildLedgerWhere>[0] = {}) {
  const { where, params } = buildLedgerWhere(filters);
  const row = await getDb().one<{ n: number }>(`select count(*) as n from buy_setup_analysis_ledger where ${where}`, [runId, staff, ...params]);
  return row?.n ?? 0;
}

/** Counts with a fixed (never user-supplied) extra predicate. */
async function countLedgerWhere(runId: string, predicate: string) {
  const row = await getDb().one<{ n: number }>(`select count(*) as n from buy_setup_analysis_ledger where run_id = $1 and ${predicate}`, [runId]);
  return row?.n ?? 0;
}

type LedgerRowWithVisibility = LedgerRow & { fundamental_result_published: boolean };

const EMPTY_SUMMARY = { totalEquities: 0, monthlyBullish: 0, weeklyBullish: 0, dailyBullish: 0, threeTimeframeQualified: 0, fifteenMinCompleted: 0, manualReview: 0, noData: 0 };

export async function getBuySetupAnalysisPage(filters: BuySetupFilters = {}): Promise<BuySetupPageResult | null> {
  const run = await getLatestPublishedRun();
  if (!run) return null;
  const viewer = await currentViewer();
  const staff = isStaff(viewer);
  const db = getDb();
  const manifest = await getBuySetupManifest(run.id);

  // Former RLS rule: enrichment evidence is visible to non-staff only once the
  // run's enrichment manifest is published. Fail closed -- show nothing rather
  // than partially-published evidence.
  const pageSize = Math.max(1, Math.min(100, Math.trunc(filters.pageSize ?? BUY_SETUP_PAGE_SIZE)));
  if (!staff && manifest?.enrichmentState !== "published") {
    return { runId: run.id, runDate: run.run_date, manifest: null, patternCoverage: null, rows: [], totalCount: 0, page: 1, pageCount: 1, pageSize, summary: EMPTY_SUMMARY };
  }

  const coverageRow = await db.one<Record<string, unknown>>(
    `select c.* from buy_setup_pattern_detector_coverage c where c.run_id = $1 and ${buySetupVisibleSql("c", "$2")}`,
    [run.id, staff],
  );
  const patternCoverage = coverageRow
    ? {
        candlestickImplemented: (coverageRow.candlestick_implemented as string[] | null) ?? [],
        candlestickNotEvaluated: (coverageRow.candlestick_not_evaluated as string[] | null) ?? [],
        chartPatternImplemented: (coverageRow.chart_pattern_implemented as string[] | null) ?? [],
        chartPatternNotEvaluated: (coverageRow.chart_pattern_not_evaluated as string[] | null) ?? [],
      }
    : null;

  const totalCount = await countLedger(run.id, staff, filters);
  const pageCount = Math.max(1, Math.ceil(totalCount / pageSize));
  const page = Math.min(Math.max(1, Math.trunc(filters.page ?? 1)), pageCount);

  // Deterministic sort with a stable tie-breaker (instrument_id) -- two rows
  // that compare equal on the requested column must still land in a fixed
  // order across pages, never re-shuffling between requests. Null ordering
  // is explicit (buy-setup-sort.ts, unit-tested): a numeric fundamental
  // score always sorts before NO_DATA/null in EITHER direction.
  const { where, params } = buildLedgerWhere(filters);
  const orderBy = buildLedgerOrderBy(buildSortSpecs(filters.sortBy, filters.sortDirection));
  const limitParam = `$${params.length + 3}`;
  const offsetParam = `$${params.length + 4}`;
  const pageRows = await db.query<LedgerRowWithVisibility>(
    `select * from buy_setup_analysis_ledger where ${where} order by ${orderBy} limit ${limitParam} offset ${offsetParam}`,
    [run.id, staff, ...params, pageSize, (page - 1) * pageSize],
  );
  const qualifiedIds = pageRows.filter((r) => r.qualified).map((r) => r.instrument_id);

  type AnyRow = Record<string, unknown> & { instrument_id: string };
  const detail = (table: string, extra = "") =>
    qualifiedIds.length === 0
      ? Promise.resolve([] as AnyRow[])
      : db.query<AnyRow>(`select t.* from ${table} t where t.run_id = $1 and t.instrument_id = any($2::text[]) ${extra}`, [run.id, qualifiedIds]);
  const [candlestickDetections, chartPatternDetections, dailyEma, chartLevels, intradayIndicators, charts, fifteenMinEma] = await Promise.all([
    detail("buy_setup_candlestick_detections"),
    detail("buy_setup_chart_pattern_detections"),
    detail("buy_setup_ema_crossover", "and t.timeframe = 'daily'"),
    detail("buy_setup_chart_levels"),
    detail("buy_setup_intraday_indicators"),
    detail("buy_setup_charts"),
    detail("buy_setup_ema_crossover", "and t.timeframe = '15m'"),
  ]);

  const groupBy = (rows: AnyRow[]) => {
    const map = new Map<string, AnyRow[]>();
    for (const row of rows) {
      const list = map.get(row.instrument_id) ?? [];
      list.push(row);
      map.set(row.instrument_id, list);
    }
    return map;
  };
  const candlestickByInstrument = groupBy(candlestickDetections);
  const chartPatternByInstrument = groupBy(chartPatternDetections);
  const dailyEmaByInstrument = groupBy(dailyEma);
  const chartLevelsByInstrument = new Map(chartLevels.map((r) => [r.instrument_id, r]));
  const intradayByInstrument = new Map(intradayIndicators.map((r) => [r.instrument_id, r]));
  const chartByInstrumentTimeframe = new Map<string, string>();
  for (const row of charts) chartByInstrumentTimeframe.set(`${row.instrument_id}:${row.timeframe}`, row.chart_object_path as string);

  const rows: BuySetupRow[] = pageRows.map((raw) => {
    // Fundamentals from an unpublished refresh manifest are staff-only.
    const fundamentalsVisible = staff || raw.fundamental_result_published;
    const entry: LedgerRow = fundamentalsVisible
      ? raw
      : { ...raw, fundamental_score: null, fundamental_grade: null, fundamental_coverage_percentage: null, fundamental_data_status: null, fundamental_sector_model: null, fundamental_as_of: null };
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
      dailyChartUrl: dailyChartPath ? chartUrl(dailyChartPath) : null,
      fifteenMinChartUrl: fifteenMinChartPath ? chartUrl(fifteenMinChartPath) : null,
      fundamentalScore: {
        score: entry.fundamental_score ?? null,
        grade: entry.fundamental_grade ?? null,
        coveragePercentage: entry.fundamental_coverage_percentage ?? null,
        dataStatus: (entry.fundamental_data_status as "SCORED" | "NO_DATA" | "MANUAL_REVIEW" | "NOT_APPLICABLE" | null) ?? "NO_DATA",
        sectorModel: entry.fundamental_sector_model ?? null,
        asOf: entry.fundamental_as_of ?? null,
      },
    };
  });

  // Fill in the 15-minute EMA crossover column (same page-scoped id set).
  const fifteenMinEmaByInstrument = groupBy(fifteenMinEma);
  for (const row of rows) {
    if (!row.qualified) continue;
    const list = fifteenMinEmaByInstrument.get(row.instrumentId) ?? [];
    const triggered = list.find((r) => r.status === "TRIGGERED") ?? list[0];
    row.fifteenMinEmaCrossover = triggered ? (triggered.status as string) : "NO_DATA";
  }

  // Summary cards: prefer the RECONCILED, validated counts from
  // buy_setup_manifests once published (per publish_buy_setup_enrichment's
  // own transactional validation) -- only fall back to a live aggregate
  // query against the ledger view while enrichment is still processing or
  // has no manifest yet, so every card on the page is always drawn from ONE
  // consistent snapshot rather than mixing a published gate count with a
  // live-recomputed 15-minute count.
  const usePublishedManifestCounts = manifest?.enrichmentState === "published";
  const [totalEquities, monthlyBullish, weeklyBullish, dailyBullish] = await Promise.all([
    countLedger(run.id, staff),
    countLedgerWhere(run.id, "monthly_result = 'PASS'"),
    countLedgerWhere(run.id, "weekly_result = 'PASS'"),
    countLedgerWhere(run.id, "daily_result = 'PASS'"),
  ]);
  const [threeTimeframeQualified, fifteenMinCompleted, manualReview, noData] = usePublishedManifestCounts
    ? [manifest.qualifiedCount, manifest.fifteenMinuteCompletedCount, manifest.manualReviewCount, manifest.noDataCount]
    : await Promise.all([
        countLedgerWhere(run.id, "gate_result = 'PASS'"),
        countLedgerWhere(run.id, "overall_status = 'TECHNICAL_EVIDENCE_PRESENT'"),
        countLedgerWhere(run.id, "overall_status = 'MANUAL_REVIEW'"),
        countLedgerWhere(run.id, "overall_status = 'NO_DATA'"),
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
type AnyRow = Record<string, unknown>;

export async function getBuySetupInstrumentDetail(instrumentId: string): Promise<{ conditions: BuySetupConditionRow[]; row: BuySetupRow | null; dailyChartUrl: string | null; fifteenMinChartUrl: string | null; patternCoverage: BuySetupPageResult["patternCoverage"] } | null> {
  const page = await getBuySetupAnalysisPage({ query: instrumentId, pageSize: 100 });
  if (!page) return null;
  const row = page.rows.find((r) => r.instrumentId === instrumentId) ?? null;
  const viewer = await currentViewer();
  const staff = isStaff(viewer);
  const db = getDb();
  const one = (table: string) =>
    db.one<AnyRow>(`select t.* from ${table} t where t.run_id = $1 and t.instrument_id = $2 and ${buySetupVisibleSql("t", "$3")}`, [page.runId, instrumentId, staff]);
  const many = (table: string) =>
    db.query<AnyRow>(`select t.* from ${table} t where t.run_id = $1 and t.instrument_id = $2 and ${buySetupVisibleSql("t", "$3")}`, [page.runId, instrumentId, staff]);

  const [gateTraces, chartLevelsRow, intradayRow, waveRow, divergenceRows, bsaTraces] = await Promise.all([
    db.query<AnyRow>(
      `select t.* from rule_traces t
        where t.run_id = $1 and t.instrument_id = $2 and t.rule_id in ('BSP-M1', 'BSP-M3')
          and ($3::boolean or exists (select 1 from screening_runs r where r.id = t.run_id and r.publication_state = 'published'))`,
      [page.runId, instrumentId, staff],
    ),
    one("buy_setup_chart_levels"),
    one("buy_setup_intraday_indicators"),
    one("buy_setup_fifteen_minute_wave"),
    many("buy_setup_divergence_evidence"),
    many("buy_setup_gate_traces"),
  ]);

  const conditions: BuySetupConditionRow[] = [];

  for (const t of gateTraces) {
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
  for (const t of bsaTraces) {
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
    const levels = chartLevelsRow;
    const intraday = intradayRow;
    const wave = waveRow;
    const divergences = divergenceRows;

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
        sourceLocator: "services/pipeline/src/run-screening/buy-setup/",
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

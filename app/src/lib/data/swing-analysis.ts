import { createClient } from "@/lib/supabase/server";
import { expectedAlignment, isAnalysisMember, type AnalysisHypothesis } from "@/lib/data/analysis-membership";

export const WBP_GATE_ORDER = ["WBP-M1", "WBP-M2", "WBP-M3", "WBP-M4", "WBP-M5", "WBP-M6", "WBP-M7", "WBP-M8"] as const;
export const WSP_GATE_ORDER = ["WSP-S1", "WSP-S2", "WSP-S3", "WSP-S4", "WSP-S5", "WSP-S6", "WSP-S7", "WSP-S8"] as const;
export const WBP_AUTOMATED_GATES = WBP_GATE_ORDER.slice(0, 4);
export const WSP_AUTOMATED_GATES = WSP_GATE_ORDER.slice(0, 4);
export const ANALYSIS_PAGE_SIZE = 20;

export type { AnalysisHypothesis } from "@/lib/data/analysis-membership";

export type RuleCondition = {
  ruleId: string;
  result: string;
  requiredCondition: string;
  explanation: string | null;
  observedValues: Record<string, unknown> | null;
  thresholds: Record<string, unknown> | null;
  sourceLocator: string | null;
  evidenceTimestamp: string | null;
  dataQuality: string;
};

export type SwingCandidate = {
  instrumentId: string;
  symbol: string;
  name: string;
  gateResults: Record<string, string>;
  automatedGatesPassed: number;
  automatedGatesTotal: number;
  selectedRoute: string | null;
  routeEvidence: unknown | null;
  pendingConditions: string[];
  finalAction: string;
  dataQuality: string;
  conditions: RuleCondition[];
  computedAt: string | null;
  dailyChartUrl: string | null;
  hourlyChartUrl: string | null;
  hourlyOpened: boolean;
};

export type SwingCandidatePage = {
  rows: SwingCandidate[];
  totalCount: number;
  page: number;
  pageCount: number;
  pageSize: number;
};

type AlignmentMembership = {
  instrument_id: string;
  final_alignment: string;
  instruments: { symbol: string; name: string | null; is_index: boolean };
};

type SwingRow = {
  id: number;
  instrument_id: string;
  mandatory_gates: Record<string, string> | null;
  selected_route: string | null;
  route_evidence: unknown | null;
  pending_conditions: unknown;
  final_action: string;
  data_quality: string;
  computed_at: string;
  daily_chart_object_path?: string | null;
  hourly_chart_object_path?: string | null;
};

type TraceRow = {
  analysis_result_id: number;
  rule_id: string;
  result: string;
  explanation: string | null;
  observed_values: Record<string, unknown> | null;
  thresholds: Record<string, unknown> | null;
  source_locator: string | null;
  required_condition?: string | null;
  evidence_timestamp?: string | null;
  data_quality?: string | null;
};

export async function getAnalysisCounts(runId: string): Promise<Record<AnalysisHypothesis, number>> {
  const supabase = await createClient();
  const count = async (hypothesis: AnalysisHypothesis) => {
    const { count: total, error } = await supabase
      .from("instrument_alignment")
      .select("instrument_id, instruments!inner(is_index)", { count: "exact", head: true })
      .eq("run_id", runId)
      .eq("final_alignment", expectedAlignment(hypothesis))
      .eq("instruments.is_index", false);
    if (error) throw error;
    return total ?? 0;
  };
  const [bullish, bearish] = await Promise.all([count("bullish"), count("bearish")]);
  return { bullish, bearish };
}

/**
 * Candidate membership is exclusively the persisted Direction alignment from
 * the same published run. Swing rows enrich that membership; they never widen
 * it, and index instruments are rejected at the membership query.
 */
export async function getSwingAnalysisPage(
  runId: string,
  hypothesis: AnalysisHypothesis,
  requestedPage = 1,
  pageSize = ANALYSIS_PAGE_SIZE
): Promise<SwingCandidatePage> {
  const supabase = await createClient();
  const { data: memberships, error: membershipError } = await supabase
    .from("instrument_alignment")
    .select("instrument_id, final_alignment, instruments!inner(symbol, name, is_index)")
    .eq("run_id", runId)
    .eq("final_alignment", expectedAlignment(hypothesis))
    .eq("instruments.is_index", false);
  if (membershipError) throw membershipError;

  const eligible = ((memberships ?? []) as unknown as AlignmentMembership[])
    .filter((row) => isAnalysisMember({ finalAlignment: row.final_alignment, isIndex: row.instruments.is_index }, hypothesis))
    .sort((a, b) => a.instruments.symbol.localeCompare(b.instruments.symbol));
  const safePageSize = Math.max(1, Math.min(50, pageSize));
  const pageCount = Math.max(1, Math.ceil(eligible.length / safePageSize));
  const page = Math.min(Math.max(1, requestedPage), pageCount);
  const pageMemberships = eligible.slice((page - 1) * safePageSize, page * safePageSize);
  const instrumentIds = pageMemberships.map((row) => row.instrument_id);
  if (instrumentIds.length === 0) return { rows: [], totalCount: eligible.length, page, pageCount, pageSize: safePageSize };

  const [{ data: resultData, error: resultError }, { data: dailyData, error: dailyError }] = await Promise.all([
    supabase.from("swing_analysis_results").select("*").eq("run_id", runId).eq("hypothesis", hypothesis).in("instrument_id", instrumentIds),
    supabase
      .from("instrument_direction_runs")
      .select("instrument_id, chart_object_path")
      .eq("run_id", runId)
      .eq("timeframe", "daily")
      .in("instrument_id", instrumentIds),
  ]);
  if (resultError) throw resultError;
  if (dailyError) throw dailyError;
  const results = (resultData ?? []) as unknown as SwingRow[];
  const resultByInstrument = new Map(results.map((row) => [row.instrument_id, row]));
  const fallbackDailyPath = new Map((dailyData ?? []).map((row) => [row.instrument_id, row.chart_object_path]));

  const resultIds = results.map((row) => row.id);
  const tracesByResultId = new Map<number, TraceRow[]>();
  if (resultIds.length > 0) {
    const { data: traces, error: traceError } = await supabase
      .from("swing_analysis_rule_traces")
      .select("*")
      .in("analysis_result_id", resultIds);
    if (traceError) throw traceError;
    for (const trace of (traces ?? []) as unknown as TraceRow[]) {
      const current = tracesByResultId.get(trace.analysis_result_id) ?? [];
      current.push(trace);
      tracesByResultId.set(trace.analysis_result_id, current);
    }
  }

  const chartPaths = new Set<string>();
  for (const membership of pageMemberships) {
    const row = resultByInstrument.get(membership.instrument_id);
    const dailyPath = row?.daily_chart_object_path ?? fallbackDailyPath.get(membership.instrument_id);
    if (dailyPath) chartPaths.add(dailyPath);
    if (row?.hourly_chart_object_path) chartPaths.add(row.hourly_chart_object_path);
  }
  const signedUrlByPath = new Map<string, string>();
  if (chartPaths.size > 0) {
    const { data: signed } = await supabase.storage.from("direction-charts").createSignedUrls([...chartPaths], 60 * 60);
    for (const item of signed ?? []) if (item.path && item.signedUrl) signedUrlByPath.set(item.path, item.signedUrl);
  }

  const automatedGates = hypothesis === "bullish" ? WBP_AUTOMATED_GATES : WSP_AUTOMATED_GATES;
  const gateOrder = hypothesis === "bullish" ? WBP_GATE_ORDER : WSP_GATE_ORDER;
  const rows = pageMemberships.map((membership): SwingCandidate => {
    const result = resultByInstrument.get(membership.instrument_id);
    const gateResults = result?.mandatory_gates ?? {};
    const conditionsById = new Map((result ? tracesByResultId.get(result.id) ?? [] : []).map((trace) => [trace.rule_id, trace]));
    const conditions = gateOrder.map((ruleId): RuleCondition => {
      const trace = conditionsById.get(ruleId);
      const thresholds = trace?.thresholds ?? null;
      return {
        ruleId,
        result: trace?.result ?? gateResults[ruleId] ?? "UNAVAILABLE",
        requiredCondition: trace?.required_condition ?? (thresholds && Object.keys(thresholds).length > 0 ? JSON.stringify(thresholds) : "See documented source locator"),
        explanation: trace?.explanation ?? (result ? "No trace was persisted for this gate." : "Analysis artifact unavailable for this aligned equity."),
        observedValues: trace?.observed_values ?? null,
        thresholds,
        sourceLocator: trace?.source_locator ?? null,
        evidenceTimestamp: trace?.evidence_timestamp ?? result?.computed_at ?? null,
        dataQuality: trace?.data_quality ?? result?.data_quality ?? "NO_DATA",
      };
    });
    const dailyPath = result?.daily_chart_object_path ?? fallbackDailyPath.get(membership.instrument_id) ?? null;
    const hourlyPath = result?.hourly_chart_object_path ?? null;
    return {
      instrumentId: membership.instrument_id,
      symbol: membership.instruments.symbol,
      name: membership.instruments.name ?? membership.instruments.symbol,
      gateResults,
      automatedGatesPassed: automatedGates.filter((gate) => gateResults[gate] === "PASS").length,
      automatedGatesTotal: automatedGates.length,
      selectedRoute: result?.selected_route ?? null,
      routeEvidence: result?.route_evidence ?? null,
      pendingConditions: Array.isArray(result?.pending_conditions) ? result.pending_conditions.filter((value): value is string => typeof value === "string") : [],
      finalAction: result?.final_action ?? "UNAVAILABLE",
      dataQuality: result?.data_quality ?? "NO_DATA",
      conditions,
      computedAt: result?.computed_at ?? null,
      dailyChartUrl: dailyPath ? signedUrlByPath.get(dailyPath) ?? null : null,
      hourlyChartUrl: hourlyPath ? signedUrlByPath.get(hourlyPath) ?? null : null,
      hourlyOpened: automatedGates.every((gate) => gateResults[gate] === "PASS"),
    };
  });

  return { rows, totalCount: eligible.length, page, pageCount, pageSize: safePageSize };
}

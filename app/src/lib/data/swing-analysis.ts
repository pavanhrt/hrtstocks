import { createClient } from "@/lib/supabase/server";

// swing_analysis_results (migration 0006) already carries one row per
// (run_id, instrument_id, hypothesis) with mandatory_gates precomputed by
// features/swing-analysis.js's evaluateSwingHypothesis() -- unlike the older
// BSP/SSP pages (lib/data/signals.ts), which have to re-derive their own
// pass/fail verdict from pooled rule_traces because BSP-*/SSP-* rules are
// hard_gate=false for cross-strategy pooling reasons, WBP-*/WSP-* rows here
// are never pooled (evaluateSwingHypothesis filters to its own prefix before
// writing), so reading this table directly already satisfies
// architecture-plan.md's Phase 5 instruction to "apply the AND of M1-M4
// itself" -- that AND was already applied server-side when this row was
// written.
export const WBP_GATE_ORDER = ["WBP-M1", "WBP-M2", "WBP-M3", "WBP-M4", "WBP-M5", "WBP-M6", "WBP-M7", "WBP-M8"] as const;
export const WSP_GATE_ORDER = ["WSP-S1", "WSP-S2", "WSP-S3", "WSP-S4", "WSP-S5", "WSP-S6", "WSP-S7", "WSP-S8"] as const;
export const WBP_AUTOMATED_GATES = ["WBP-M1", "WBP-M2", "WBP-M3", "WBP-M4"] as const;
export const WSP_AUTOMATED_GATES = ["WSP-S1", "WSP-S2", "WSP-S3", "WSP-S4"] as const;
export const WBP_MANUAL_GATES = ["WBP-M5", "WBP-M6", "WBP-M7", "WBP-M8"] as const;
export const WSP_MANUAL_GATES = ["WSP-S5", "WSP-S6", "WSP-S7", "WSP-S8"] as const;

export type RuleCondition = {
  ruleId: string;
  result: string;
  explanation: string | null;
  observedValues: Record<string, unknown> | null;
  thresholds: Record<string, unknown> | null;
};

export type SwingCandidate = {
  instrumentId: string;
  symbol: string;
  name: string;
  gateResults: Record<string, string>;
  automatedGatesPassed: number;
  automatedGatesTotal: number;
  selectedRoute: string | null;
  // Full evidence behind whichever hourly route detector matched -- see
  // features/hourly-routes.js's detectWave3Ignition/detectWave2Pullback for
  // the exact shape (trigger/volume/rule-3-forward-check for BUY-1/SELL-3,
  // Fibonacci-band/PAPA-trigger for BUY-4/SELL-4). Null whenever no route
  // has been detected this run -- either the weekly+daily direction lock
  // (M1-M4/S1-S4) hasn't cleared yet (1-hour bars are never even fetched
  // until it does, architecture-plan.md Phase 2), or it cleared but matched
  // none of the 2 (of 10) implemented hourly routes.
  routeEvidence: unknown | null;
  pendingConditions: string[];
  finalAction: string;
  dataQuality: string;
  // One row per gate (WBP-M1..M8 or WSP-S1..S8), in canonical order --
  // swing_analysis_rule_traces, the same real explanation/observed_values
  // every automated gate's evaluateRules() trace carries, filtered to this
  // hypothesis's own rows (never pooled, see the module comment above).
  conditions: RuleCondition[];
};

/**
 * One row per instrument that has a swing_analysis_results row for this run
 * and hypothesis (i.e. it had at least one WBP-/WSP- prefixed trace to
 * filter -- see evaluateSwingHypothesis's own "returns null when neither
 * hypothesis has any swing-gate traces at all" note), ranked by how many of
 * the four automated weekly+daily direction-lock gates (M1-M4) came back
 * PASS.
 */
export async function getSwingAnalysisCandidates(
  runId: string,
  hypothesis: "bullish" | "bearish"
): Promise<SwingCandidate[]> {
  const automatedGates = hypothesis === "bullish" ? WBP_AUTOMATED_GATES : WSP_AUTOMATED_GATES;
  const gateOrder = hypothesis === "bullish" ? WBP_GATE_ORDER : WSP_GATE_ORDER;

  const supabase = await createClient();
  const { data: rows, error } = await supabase
    .from("swing_analysis_results")
    .select("id, instrument_id, mandatory_gates, selected_route, route_evidence, pending_conditions, final_action, data_quality")
    .eq("run_id", runId)
    .eq("hypothesis", hypothesis);
  if (error) throw error;
  if (!rows || rows.length === 0) return [];

  const instrumentIds = rows.map((r) => r.instrument_id);
  const { data: instruments, error: instError } = await supabase
    .from("instruments")
    .select("id, symbol, name")
    .in("id", instrumentIds);
  if (instError) throw instError;
  const instrumentById = new Map((instruments ?? []).map((i) => [i.id, i]));

  // "All the analysis conditions": the real per-gate explanation/observed
  // values behind every badge, not just the pass/fail color -- one query
  // for every candidate row's own conditions via analysis_result_id.
  const resultIds = rows.map((r) => r.id);
  const { data: traces, error: traceError } = await supabase
    .from("swing_analysis_rule_traces")
    .select("analysis_result_id, rule_id, result, explanation, observed_values, thresholds")
    .in("analysis_result_id", resultIds);
  if (traceError) throw traceError;
  const tracesByResultId = new Map<number, RuleCondition[]>();
  for (const t of traces ?? []) {
    if (!tracesByResultId.has(t.analysis_result_id)) tracesByResultId.set(t.analysis_result_id, []);
    tracesByResultId.get(t.analysis_result_id)!.push({
      ruleId: t.rule_id,
      result: t.result,
      explanation: t.explanation,
      observedValues: t.observed_values as Record<string, unknown> | null,
      thresholds: t.thresholds as Record<string, unknown> | null,
    });
  }

  const candidates: SwingCandidate[] = rows.map((r) => {
    const gateResults = (r.mandatory_gates ?? {}) as Record<string, string>;
    const automatedGatesPassed = automatedGates.filter((g) => gateResults[g] === "PASS").length;
    const instrument = instrumentById.get(r.instrument_id);
    const conditionsById = new Map((tracesByResultId.get(r.id) ?? []).map((c) => [c.ruleId, c]));
    const conditions = gateOrder.map(
      (ruleId) => conditionsById.get(ruleId) ?? { ruleId, result: gateResults[ruleId] ?? "NO_DATA", explanation: null, observedValues: null, thresholds: null }
    );
    return {
      instrumentId: r.instrument_id,
      symbol: instrument?.symbol ?? r.instrument_id,
      name: instrument?.name ?? r.instrument_id,
      gateResults,
      automatedGatesPassed,
      automatedGatesTotal: automatedGates.length,
      selectedRoute: r.selected_route,
      routeEvidence: r.route_evidence,
      pendingConditions: (r.pending_conditions ?? []) as string[],
      finalAction: r.final_action,
      dataQuality: r.data_quality,
      conditions,
    };
  });

  candidates.sort(
    (a, b) => b.automatedGatesPassed - a.automatedGatesPassed || a.symbol.localeCompare(b.symbol)
  );
  return candidates;
}

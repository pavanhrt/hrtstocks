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
export const WBP_AUTOMATED_GATES = ["WBP-M1", "WBP-M2", "WBP-M3", "WBP-M4"] as const;
export const WSP_AUTOMATED_GATES = ["WSP-S1", "WSP-S2", "WSP-S3", "WSP-S4"] as const;
export const WBP_MANUAL_GATES = ["WBP-M5", "WBP-M6", "WBP-M7", "WBP-M8"] as const;
export const WSP_MANUAL_GATES = ["WSP-S5", "WSP-S6", "WSP-S7", "WSP-S8"] as const;

export type SwingCandidate = {
  instrumentId: string;
  symbol: string;
  name: string;
  gateResults: Record<string, string>;
  automatedGatesPassed: number;
  automatedGatesTotal: number;
  selectedRoute: string | null;
  pendingConditions: string[];
  finalAction: string;
  dataQuality: string;
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

  const supabase = await createClient();
  const { data: rows, error } = await supabase
    .from("swing_analysis_results")
    .select("instrument_id, mandatory_gates, selected_route, pending_conditions, final_action, data_quality")
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

  const candidates: SwingCandidate[] = rows.map((r) => {
    const gateResults = (r.mandatory_gates ?? {}) as Record<string, string>;
    const automatedGatesPassed = automatedGates.filter((g) => gateResults[g] === "PASS").length;
    const instrument = instrumentById.get(r.instrument_id);
    return {
      instrumentId: r.instrument_id,
      symbol: instrument?.symbol ?? r.instrument_id,
      name: instrument?.name ?? r.instrument_id,
      gateResults,
      automatedGatesPassed,
      automatedGatesTotal: automatedGates.length,
      selectedRoute: r.selected_route,
      pendingConditions: (r.pending_conditions ?? []) as string[],
      finalAction: r.final_action,
      dataQuality: r.data_quality,
    };
  });

  candidates.sort(
    (a, b) => b.automatedGatesPassed - a.automatedGatesPassed || a.symbol.localeCompare(b.symbol)
  );
  return candidates;
}

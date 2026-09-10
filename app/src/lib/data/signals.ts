import { createClient } from "@/lib/supabase/server";

// The five gates in each playbook that features/context.js + features/structure.js
// can actually compute from OHLCV bars (Dow structure, MACD histogram phase,
// daily Stochastic/RSI crossover). The other five gates per playbook (Elliott
// wave position, the daily Elliott setup, the PAPA trigger, and reward:risk)
// are MANUAL_REVIEW sentinels in strategies/buy-signal-playbook.yaml and
// sell-signal-playbook.yaml -- see those files for why. These rule_definitions
// rows are all seeded with hard_gate=false (evaluateRules()/classify() pool
// hard-gate failures across every active strategy with no direction scoping,
// so a bullish-only or bearish-only hard gate there would force every
// instrument to FAIL overall -- see the YAML notes), which is why this page
// computes its own pass/fail verdict directly from rule_traces instead of
// relying on instrument_run_results.tier.
export const BUY_CODEABLE_GATES = ["BSP-M1", "BSP-M3", "BSP-M4B", "BSP-M7A", "BSP-M7B"] as const;
export const SELL_CODEABLE_GATES = ["SSP-S1", "SSP-S3", "SSP-S4B", "SSP-S7A", "SSP-S7B"] as const;
export const BUY_MANUAL_GATES = ["BSP-M2", "BSP-M4A", "BSP-M5", "BSP-M6", "BSP-M8"] as const;
export const SELL_MANUAL_GATES = ["SSP-S2", "SSP-S4A", "SSP-S5", "SSP-S6", "SSP-S8"] as const;

export type SignalCandidate = {
  instrumentId: string;
  symbol: string;
  name: string;
  gateResults: Record<string, string>;
  codeableGatesPassed: number;
  codeableGatesTotal: number;
};

/**
 * One row per instrument that has BSP-* or SSP-* rule_traces for this run
 * (i.e. its data quality was PASS -- see index.js's evaluateInstrument,
 * which never evaluates rules otherwise), ranked by how many of the five
 * codeable gates for that direction came back PASS.
 */
export async function getSignalCandidates(
  runId: string,
  framework: "BSP" | "SSP"
): Promise<SignalCandidate[]> {
  const codeableGates = framework === "BSP" ? BUY_CODEABLE_GATES : SELL_CODEABLE_GATES;
  const allGateIds = [
    ...(framework === "BSP" ? [...BUY_CODEABLE_GATES, ...BUY_MANUAL_GATES] : [...SELL_CODEABLE_GATES, ...SELL_MANUAL_GATES]),
  ];

  const supabase = await createClient();
  const { data: traces, error } = await supabase
    .from("rule_traces")
    .select("instrument_id, rule_id, result")
    .eq("run_id", runId)
    .in("rule_id", allGateIds);
  if (error) throw error;
  if (!traces || traces.length === 0) return [];

  const byInstrument = new Map<string, Record<string, string>>();
  for (const t of traces) {
    if (!byInstrument.has(t.instrument_id)) byInstrument.set(t.instrument_id, {});
    byInstrument.get(t.instrument_id)![t.rule_id] = t.result;
  }

  const instrumentIds = [...byInstrument.keys()];
  const { data: instruments, error: instError } = await supabase
    .from("instruments")
    .select("id, symbol, name")
    .in("id", instrumentIds);
  if (instError) throw instError;
  const instrumentById = new Map((instruments ?? []).map((i) => [i.id, i]));

  const candidates: SignalCandidate[] = instrumentIds.map((instrumentId) => {
    const gateResults = byInstrument.get(instrumentId)!;
    const codeableGatesPassed = codeableGates.filter((g) => gateResults[g] === "PASS").length;
    const instrument = instrumentById.get(instrumentId);
    return {
      instrumentId,
      symbol: instrument?.symbol ?? instrumentId,
      name: instrument?.name ?? instrumentId,
      gateResults,
      codeableGatesPassed,
      codeableGatesTotal: codeableGates.length,
    };
  });

  candidates.sort((a, b) => b.codeableGatesPassed - a.codeableGatesPassed || a.symbol.localeCompare(b.symbol));
  return candidates;
}

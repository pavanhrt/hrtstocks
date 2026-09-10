import { createClient } from "@/lib/supabase/server";

/**
 * Most recent run of ANY status, visible to the caller's role. RLS already
 * restricts a plain Viewer to completed runs (see `screening_runs_read` in
 * 0002_rls.sql), so this only ever returns a running/partial/failed run for
 * Researcher+ roles.
 *
 * Deliberately for operational pages only (Dashboard, Data health) that
 * display the run's status prominently, so an in-progress or failed run is
 * never presented as if it were normal current data. Every other page that
 * shows analysis results (Buy/Sell signals, the stock ledger, a stock's
 * detail page, Indexes, News) must use `getLatestPublishedRun()` instead --
 * closes the bug where a Researcher+ user's dashboard, ledger, etc. would
 * silently show numbers from an incomplete run with no indication anything
 * was off.
 */
export async function getLatestRun() {
  const supabase = await createClient();
  const { data, error } = await supabase
    .from("screening_runs")
    .select("*")
    .order("run_date", { ascending: false })
    .order("created_at", { ascending: false })
    .limit(1)
    .maybeSingle();
  if (error) throw error;
  return data;
}

/**
 * Most recent COMPLETED run, regardless of caller role. This is "the
 * published run" -- what every content page (as opposed to an operational
 * status page) should treat as the current analysis. A running, partial, or
 * failed run -- even one more recent than the last completed run -- is never
 * returned here.
 */
export async function getLatestPublishedRun() {
  const supabase = await createClient();
  const { data, error } = await supabase
    .from("screening_runs")
    .select("*")
    .eq("status", "completed")
    .order("run_date", { ascending: false })
    .order("created_at", { ascending: false })
    .limit(1)
    .maybeSingle();
  if (error) throw error;
  return data;
}

export async function getCoverage(runId: string) {
  const supabase = await createClient();
  const { data, error } = await supabase
    .from("coverage_reconciliation")
    .select("*")
    .eq("run_id", runId)
    .maybeSingle();
  if (error) throw error;
  return data;
}

export async function getTierCounts(runId: string) {
  const supabase = await createClient();
  const { data, error } = await supabase
    .from("instrument_run_results")
    .select("tier")
    .eq("run_id", runId)
    .eq("is_index", false);
  if (error) throw error;

  const counts: Record<string, number> = {};
  for (const row of data ?? []) {
    const key = row.tier ?? "unclassified";
    counts[key] = (counts[key] ?? 0) + 1;
  }
  return counts;
}

export async function getIndexResults(runId: string) {
  const supabase = await createClient();
  const { data, error } = await supabase
    .from("instrument_run_results")
    .select("*, instruments(symbol, name)")
    .eq("run_id", runId)
    .eq("is_index", true);
  if (error) throw error;
  return data ?? [];
}

export async function getTopCandidates(runId: string, limit = 10) {
  const supabase = await createClient();
  const { data, error } = await supabase
    .from("rankings")
    .select("*, instruments(symbol, name)")
    .eq("run_id", runId)
    .in("tier", ["tier_a", "tier_b"])
    .order("tier", { ascending: true })
    .order("rank_within_tier", { ascending: true })
    .limit(limit);
  if (error) throw error;
  return data ?? [];
}

export async function getStockLedger(runId: string) {
  const supabase = await createClient();
  const { data, error } = await supabase
    .from("instrument_run_results")
    .select("*, instruments(symbol, name)")
    .eq("run_id", runId)
    .eq("is_index", false)
    .order("instrument_id", { ascending: true });
  if (error) throw error;
  return data ?? [];
}

export async function getRuleTraces(runId: string, instrumentId: string) {
  const supabase = await createClient();
  const { data, error } = await supabase
    .from("rule_traces")
    .select("*")
    .eq("run_id", runId)
    .eq("instrument_id", instrumentId)
    .order("rule_id", { ascending: true });
  if (error) throw error;
  return data ?? [];
}

/** Last N runs' results for the four index instruments, oldest first, for the regime-comparison view. */
export async function getIndexHistory(limit = 10) {
  const supabase = await createClient();
  const { data: runs, error: runsError } = await supabase
    .from("screening_runs")
    .select("id, run_date")
    .order("run_date", { ascending: false })
    .limit(limit);
  if (runsError) throw runsError;
  if (!runs || runs.length === 0) return { runs: [], resultsByRun: {} as Record<string, Awaited<ReturnType<typeof getIndexResults>>> };

  const runIds = runs.map((r) => r.id);
  const { data, error } = await supabase
    .from("instrument_run_results")
    .select("*, instruments(symbol, name)")
    .in("run_id", runIds)
    .eq("is_index", true);
  if (error) throw error;

  const resultsByRun: Record<string, typeof data> = {};
  for (const row of data ?? []) {
    (resultsByRun[row.run_id] ??= []).push(row);
  }
  return { runs: runs.reverse(), resultsByRun };
}

/** Looks up the currently-active rule_definitions for a set of business rule ids (e.g. "SMM-TWR-001"), for enriching rule_traces with direction/framework/hard_gate. */
export async function getRuleDefinitionsByIds(ruleIds: string[]) {
  if (ruleIds.length === 0) return {} as Record<string, { framework: string; direction: string | null; name: string; hard_gate: boolean; source_status: string }>;
  const supabase = await createClient();
  const { data, error } = await supabase
    .from("rule_definitions")
    .select("rule_id, framework, direction, name, hard_gate, source_status")
    .in("rule_id", ruleIds);
  if (error) throw error;

  const map: Record<string, (typeof data)[number]> = {};
  for (const row of data ?? []) map[row.rule_id] = row;
  return map;
}

export async function getDataQualityIssues(runId: string) {
  const supabase = await createClient();
  const { data, error } = await supabase
    .from("data_quality_results")
    .select("*, instruments(symbol, name)")
    .eq("run_id", runId)
    .neq("result", "PASS")
    .order("created_at", { ascending: false });
  if (error) throw error;
  return data ?? [];
}

export async function getPipelineAuditLog(runId: string) {
  const supabase = await createClient();
  const { data, error } = await supabase
    .from("pipeline_audit_log")
    .select("*")
    .eq("run_id", runId)
    .order("created_at", { ascending: true });
  if (error) throw error;
  return data ?? [];
}

export async function getRecentRuns(limit = 15) {
  const supabase = await createClient();
  const { data, error } = await supabase
    .from("screening_runs")
    .select("*")
    .order("run_date", { ascending: false })
    .limit(limit);
  if (error) throw error;
  return data ?? [];
}

export async function getInstrument(instrumentId: string) {
  const supabase = await createClient();
  const { data, error } = await supabase
    .from("instruments")
    .select("*")
    .eq("id", instrumentId)
    .maybeSingle();
  if (error) throw error;
  return data;
}

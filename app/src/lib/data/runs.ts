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
 * Most recent immutable published run. A newer processing, failed, or merely
 * validated run can never replace the snapshot shown on content pages. The
 * fallback supports installations where the publication lifecycle migration
 * has not been applied yet.
 */
export async function getLatestPublishedRun() {
  const supabase = await createClient();
  const published = await supabase
    .from("screening_runs")
    .select("*")
    .eq("status", "completed")
    .filter("publication_state", "eq", "published")
    .order("run_date", { ascending: false })
    .order("created_at", { ascending: false })
    .limit(1)
    .maybeSingle();
  if (!published.error) return published.data;
  if (published.error.code !== "PGRST204" && published.error.code !== "42703") throw published.error;

  const legacy = await supabase
    .from("screening_runs")
    .select("*")
    .eq("status", "completed")
    .order("run_date", { ascending: false })
    .order("created_at", { ascending: false })
    .limit(1)
    .maybeSingle();
  if (legacy.error) throw legacy.error;
  return legacy.data;
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

export async function getStockLedgerPage(
  runId: string,
  { page = 1, pageSize = 50, query = "", tier = "all", state = "all" } = {}
) {
  const rows = await getStockLedger(runId);
  const normalizedQuery = query.trim().toLocaleLowerCase();
  const filtered = rows.filter((raw) => {
    const row = raw as typeof raw & { instruments: { symbol: string; name: string | null } | null };
    if (normalizedQuery && !`${row.instrument_id} ${row.instruments?.symbol ?? ""} ${row.instruments?.name ?? ""}`.toLocaleLowerCase().includes(normalizedQuery)) return false;
    if (tier !== "all" && (row.tier ?? "unclassified") !== tier) return false;
    if (state !== "all" && row.terminal_state !== state) return false;
    return true;
  });
  const safePageSize = Math.max(1, Math.min(100, pageSize));
  const pageCount = Math.max(1, Math.ceil(filtered.length / safePageSize));
  const safePage = Math.min(Math.max(1, page), pageCount);
  return {
    rows: filtered.slice((safePage - 1) * safePageSize, safePage * safePageSize),
    totalCount: filtered.length,
    universeCount: rows.length,
    page: safePage,
    pageCount,
    pageSize: safePageSize,
  };
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

export async function getRuleTracePage(runId: string, instrumentId: string, requestedPage = 1, pageSize = 24) {
  const supabase = await createClient();
  const safePageSize = Math.max(1, Math.min(100, pageSize));
  const { count, error: countError } = await supabase
    .from("rule_traces")
    .select("id", { count: "exact", head: true })
    .eq("run_id", runId)
    .eq("instrument_id", instrumentId);
  if (countError) throw countError;
  const totalCount = count ?? 0;
  const pageCount = Math.max(1, Math.ceil(totalCount / safePageSize));
  const page = Math.min(Math.max(1, requestedPage), pageCount);
  const { data, error } = await supabase
    .from("rule_traces")
    .select("*")
    .eq("run_id", runId)
    .eq("instrument_id", instrumentId)
    .order("rule_id", { ascending: true })
    .range((page - 1) * safePageSize, page * safePageSize - 1);
  if (error) throw error;
  return { rows: data ?? [], totalCount, page, pageCount, pageSize: safePageSize };
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

export type RunProgress = {
  expectedCount: number;
  processedCount: number;
  batchesPending: number;
  batchesInProgress: number;
  batchesDone: number;
  batchesFailed: number;
};

/**
 * Live progress for a run, computed on read from pipeline_batches +
 * instrument_run_results -- deliberately not stored as mutable columns on
 * screening_runs (avoids redundant state that could drift from the truth).
 * `expectedCount` is the union of every 'incremental' batch's own
 * instrument list (the real expected non-index universe for this run, not
 * a guess) -- see supabase/functions/run-screening/index.ts's
 * uniqueInstrumentsFromCursors, the same logic mirrored here for display.
 * Returns null if pipeline_batches has no rows for this run (migration 0008
 * not applied yet, or RLS hid them from a non-researcher caller) so the
 * page can simply skip this section rather than show a misleading zero.
 */
export async function getRunProgress(runId: string): Promise<RunProgress | null> {
  const supabase = await createClient();
  const { data: batches, error } = await supabase.from("pipeline_batches").select("stage, status, cursor").eq("run_id", runId);
  if (error || !batches || batches.length === 0) return null;

  const expectedIds = new Set<string>();
  for (const b of batches) {
    if (b.stage !== "incremental" || !b.cursor) continue;
    const items = JSON.parse(b.cursor) as { instrumentId: string; isIndex: boolean }[];
    for (const item of items) {
      if (!item.isIndex) expectedIds.add(item.instrumentId);
    }
  }

  const { count: processedCount } = await supabase
    .from("instrument_run_results")
    .select("instrument_id", { count: "exact", head: true })
    .eq("run_id", runId)
    .eq("is_index", false);

  const counts: Record<string, number> = { pending: 0, in_progress: 0, done: 0, failed: 0 };
  for (const b of batches) {
    if (b.status in counts) counts[b.status]++;
  }

  return {
    expectedCount: expectedIds.size,
    processedCount: processedCount ?? 0,
    batchesPending: counts.pending,
    batchesInProgress: counts.in_progress,
    batchesDone: counts.done,
    batchesFailed: counts.failed,
  };
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

export type PublicationManifest = {
  expected_equities: number;
  expected_indexes: number;
  result_equities: number;
  result_indexes: number;
  eligible_equities: number;
  alignment_equities: number;
  direction_rows: number;
  chart_rows: number;
  analysis_bar_equities: number;
  trace_equities: number;
  missing_aligned_analysis: number;
  missing_storage_objects: number;
  critical_persistence_errors: number;
  future_analysis_bars: number;
  coverage_reconciled: boolean;
  validation_errors: string[];
  validated_at: string;
  published_at: string | null;
};

export async function getPublicationManifest(runId: string): Promise<PublicationManifest | null> {
  const supabase = await createClient();
  const { data, error } = await supabase
    .from("run_publication_manifests" as "coverage_reconciliation")
    .select("*")
    .eq("run_id", runId)
    .maybeSingle();
  if (error) {
    if (error.code === "PGRST205" || error.code === "42703") return null;
    throw error;
  }
  return data as unknown as PublicationManifest | null;
}

export async function getPersistenceErrorCount(runId: string): Promise<number | null> {
  const supabase = await createClient();
  const { count, error } = await supabase
    .from("pipeline_persistence_errors" as "pipeline_audit_log")
    .select("id", { count: "exact", head: true })
    .eq("run_id", runId);
  if (error) {
    if (error.code === "PGRST205" || error.code === "42703") return null;
    throw error;
  }
  return count ?? 0;
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

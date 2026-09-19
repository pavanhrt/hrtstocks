import { currentViewer } from "../access.ts";
import { getDb } from "../db/pool.ts";
import { isStaff, runVisibleSql, staffOnly } from "../db/visibility.ts";
import type { Tables } from "../database.types.ts";

// Every query here is explicit, parameterized SQL. Row visibility that used to
// be enforced by Supabase RLS is applied through ../db/visibility.ts using the
// viewer resolved server-side by ../access.ts.

type InstrumentRef = { symbol: string; name: string | null } | null;
export type RunResultWithInstrument = Tables<"instrument_run_results"> & { instruments: InstrumentRef };

const INSTRUMENT_JSON = "json_build_object('symbol', i.symbol, 'name', i.name)";

/**
 * Most recent run of ANY status the caller may see. Viewers only ever see
 * published runs; staff also see running/partial/failed runs.
 *
 * Deliberately for operational pages only (Dashboard, Data health) that
 * display the run's status prominently, so an in-progress or failed run is
 * never presented as if it were normal current data. Every other page that
 * shows analysis results (the stock ledger, a stock's detail page, Indexes,
 * News) must use `getLatestPublishedRun()` instead.
 */
export async function getLatestRun() {
  const viewer = await currentViewer();
  return getDb().one<Tables<"screening_runs">>(
    `select * from screening_runs
      where ($1::boolean or publication_state = 'published')
      order by run_date desc, created_at desc
      limit 1`,
    [isStaff(viewer)],
  );
}

/**
 * Most recent immutable published run. A newer processing, failed, or merely
 * validated run can never replace the snapshot shown on content pages.
 */
export async function getLatestPublishedRun() {
  await currentViewer();
  return getDb().one<Tables<"screening_runs">>(
    `select * from screening_runs
      where status = 'completed' and publication_state = 'published'
      order by run_date desc, created_at desc
      limit 1`,
  );
}

export async function getCoverage(runId: string) {
  const viewer = await currentViewer();
  return getDb().one<Tables<"coverage_reconciliation">>(
    `select c.* from coverage_reconciliation c
      where c.run_id = $1 and ${runVisibleSql("c", "$2")}`,
    [runId, isStaff(viewer)],
  );
}

export async function getTierCounts(runId: string) {
  const viewer = await currentViewer();
  const rows = await getDb().query<{ tier: string | null; n: number }>(
    `select t.tier::text as tier, count(*) as n
       from instrument_run_results t
      where t.run_id = $1 and t.is_index = false and ${runVisibleSql("t", "$2")}
      group by t.tier`,
    [runId, isStaff(viewer)],
  );
  const counts: Record<string, number> = {};
  for (const row of rows) counts[row.tier ?? "unclassified"] = (counts[row.tier ?? "unclassified"] ?? 0) + row.n;
  return counts;
}

export async function getIndexResults(runId: string): Promise<RunResultWithInstrument[]> {
  const viewer = await currentViewer();
  return getDb().query<RunResultWithInstrument>(
    `select r.*, ${INSTRUMENT_JSON} as instruments
       from instrument_run_results r
       left join instruments i on i.id = r.instrument_id
      where r.run_id = $1 and r.is_index = true and ${runVisibleSql("r", "$2")}`,
    [runId, isStaff(viewer)],
  );
}

export async function getTopCandidates(runId: string, limit = 10) {
  const viewer = await currentViewer();
  return getDb().query<Tables<"rankings"> & { instruments: InstrumentRef }>(
    `select k.*, ${INSTRUMENT_JSON} as instruments
       from rankings k
       left join instruments i on i.id = k.instrument_id
      where k.run_id = $1 and k.tier in ('tier_a', 'tier_b') and ${runVisibleSql("k", "$2")}
      order by k.tier asc, k.rank_within_tier asc
      limit $3`,
    [runId, isStaff(viewer), Math.max(1, Math.min(500, Math.trunc(limit)))],
  );
}

export async function getStockLedger(runId: string): Promise<RunResultWithInstrument[]> {
  const viewer = await currentViewer();
  return getDb().query<RunResultWithInstrument>(
    `select r.*, ${INSTRUMENT_JSON} as instruments
       from instrument_run_results r
       left join instruments i on i.id = r.instrument_id
      where r.run_id = $1 and r.is_index = false and ${runVisibleSql("r", "$2")}
      order by r.instrument_id asc`,
    [runId, isStaff(viewer)],
  );
}

export async function getStockLedgerPage(
  runId: string,
  { page = 1, pageSize = 50, query = "", tier = "all", state = "all" } = {},
) {
  const rows = await getStockLedger(runId);
  const normalizedQuery = query.trim().toLocaleLowerCase();
  const filtered = rows.filter((row) => {
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
  const viewer = await currentViewer();
  return getDb().query<Tables<"rule_traces">>(
    `select t.* from rule_traces t
      where t.run_id = $1 and t.instrument_id = $2 and ${runVisibleSql("t", "$3")}
      order by t.rule_id asc`,
    [runId, instrumentId, isStaff(viewer)],
  );
}

export async function getRuleTracePage(runId: string, instrumentId: string, requestedPage = 1, pageSize = 24) {
  const viewer = await currentViewer();
  const safePageSize = Math.max(1, Math.min(100, Math.trunc(pageSize)));
  const staff = isStaff(viewer);
  const counted = await getDb().one<{ n: number }>(
    `select count(*) as n from rule_traces t
      where t.run_id = $1 and t.instrument_id = $2 and ${runVisibleSql("t", "$3")}`,
    [runId, instrumentId, staff],
  );
  const totalCount = counted?.n ?? 0;
  const pageCount = Math.max(1, Math.ceil(totalCount / safePageSize));
  const page = Math.min(Math.max(1, Math.trunc(requestedPage)), pageCount);
  const rows = await getDb().query<Tables<"rule_traces">>(
    `select t.* from rule_traces t
      where t.run_id = $1 and t.instrument_id = $2 and ${runVisibleSql("t", "$3")}
      order by t.rule_id asc
      limit $4 offset $5`,
    [runId, instrumentId, staff, safePageSize, (page - 1) * safePageSize],
  );
  return { rows, totalCount, page, pageCount, pageSize: safePageSize };
}

/** Last N runs' results for the four index instruments, oldest first, for the regime-comparison view. */
export async function getIndexHistory(limit = 10) {
  const viewer = await currentViewer();
  const staff = isStaff(viewer);
  const runs = await getDb().query<{ id: string; run_date: string }>(
    `select id, run_date from screening_runs
      where ($1::boolean or publication_state = 'published')
      order by run_date desc
      limit $2`,
    [staff, Math.max(1, Math.min(100, Math.trunc(limit)))],
  );
  if (runs.length === 0) return { runs: [], resultsByRun: {} as Record<string, RunResultWithInstrument[]> };

  const data = await getDb().query<RunResultWithInstrument>(
    `select r.*, ${INSTRUMENT_JSON} as instruments
       from instrument_run_results r
       left join instruments i on i.id = r.instrument_id
      where r.run_id = any($1::uuid[]) and r.is_index = true`,
    [runs.map((r) => r.id)],
  );
  const resultsByRun: Record<string, RunResultWithInstrument[]> = {};
  for (const row of data) (resultsByRun[row.run_id] ??= []).push(row);
  return { runs: runs.reverse(), resultsByRun };
}

type RuleDefinitionSummary = { framework: string; direction: string | null; name: string; hard_gate: boolean; source_status: string };

/** Looks up the currently-active rule_definitions for a set of business rule ids (e.g. "SMM-TWR-001"), for enriching rule_traces with direction/framework/hard_gate. */
export async function getRuleDefinitionsByIds(ruleIds: string[]) {
  if (ruleIds.length === 0) return {} as Record<string, RuleDefinitionSummary>;
  await currentViewer();
  const rows = await getDb().query<RuleDefinitionSummary & { rule_id: string }>(
    `select rule_id, framework, direction, name, hard_gate, source_status
       from rule_definitions where rule_id = any($1::text[])`,
    [ruleIds],
  );
  const map: Record<string, RuleDefinitionSummary> = {};
  for (const row of rows) map[row.rule_id] = row;
  return map;
}

/** Staff only (data_quality_results was a staff-only table under RLS). */
export async function getDataQualityIssues(runId: string) {
  const viewer = await currentViewer();
  return staffOnly<(Tables<"data_quality_results"> & { instruments: InstrumentRef })[]>(viewer, [], () =>
    getDb().query(
      `select d.*, ${INSTRUMENT_JSON} as instruments
         from data_quality_results d
         left join instruments i on i.id = d.instrument_id
        where d.run_id = $1 and d.result <> 'PASS'
        order by d.created_at desc`,
      [runId],
    ),
  );
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
 * `expectedCount` is the union of every 'incremental' batch's own instrument
 * list (the real expected non-index universe for this run, not a guess).
 * Returns null for non-staff (pipeline_batches is staff-only) or when the run
 * has no batches, so the page skips this section instead of showing a zero.
 */
export async function getRunProgress(runId: string): Promise<RunProgress | null> {
  const viewer = await currentViewer();
  return staffOnly<RunProgress | null>(viewer, null, async () => {
    const db = getDb();
    const batches = await db.query<{ stage: string; status: string; cursor: string | null }>(
      `select stage, status, cursor from pipeline_batches where run_id = $1`,
      [runId],
    );
    if (batches.length === 0) return null;

    const expectedIds = new Set<string>();
    for (const b of batches) {
      if (b.stage !== "incremental" || !b.cursor) continue;
      const items = JSON.parse(b.cursor) as { instrumentId: string; isIndex: boolean }[];
      for (const item of items) if (!item.isIndex) expectedIds.add(item.instrumentId);
    }
    const processed = await db.one<{ n: number }>(
      `select count(*) as n from instrument_run_results where run_id = $1 and is_index = false`,
      [runId],
    );
    const counts: Record<string, number> = { pending: 0, in_progress: 0, done: 0, failed: 0 };
    for (const b of batches) if (b.status in counts) counts[b.status]++;
    return {
      expectedCount: expectedIds.size,
      processedCount: processed?.n ?? 0,
      batchesPending: counts.pending,
      batchesInProgress: counts.in_progress,
      batchesDone: counts.done,
      batchesFailed: counts.failed,
    };
  });
}

export async function getPipelineAuditLog(runId: string) {
  const viewer = await currentViewer();
  return staffOnly<Tables<"pipeline_audit_log">[]>(viewer, [], () =>
    getDb().query(`select * from pipeline_audit_log where run_id = $1 order by created_at asc`, [runId]),
  );
}

export async function getRecentRuns(limit = 15) {
  const viewer = await currentViewer();
  return getDb().query<Tables<"screening_runs">>(
    `select * from screening_runs
      where ($1::boolean or publication_state = 'published')
      order by run_date desc
      limit $2`,
    [isStaff(viewer), Math.max(1, Math.min(100, Math.trunc(limit)))],
  );
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
  const viewer = await currentViewer();
  return getDb().one<PublicationManifest>(
    `select m.* from run_publication_manifests m
      where m.run_id = $1 and ${runVisibleSql("m", "$2")}`,
    [runId, isStaff(viewer)],
  );
}

/** Staff only (pipeline_persistence_errors was staff-only under RLS); null for non-staff. */
export async function getPersistenceErrorCount(runId: string): Promise<number | null> {
  const viewer = await currentViewer();
  return staffOnly<number | null>(viewer, null, async () => {
    const row = await getDb().one<{ n: number }>(`select count(*) as n from pipeline_persistence_errors where run_id = $1`, [runId]);
    return row?.n ?? 0;
  });
}

export async function getInstrument(instrumentId: string) {
  await currentViewer();
  return getDb().one<Tables<"instruments">>(`select * from instruments where id = $1`, [instrumentId]);
}

/** One instrument's ledger row for a run (visibility-checked like every run-scoped read). */
export async function getInstrumentRunResult(runId: string, instrumentId: string) {
  const viewer = await currentViewer();
  return getDb().one<Tables<"instrument_run_results">>(
    `select r.* from instrument_run_results r
      where r.run_id = $1 and r.instrument_id = $2 and ${runVisibleSql("r", "$3")}`,
    [runId, instrumentId, isStaff(viewer)],
  );
}

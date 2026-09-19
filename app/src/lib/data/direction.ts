import { currentViewer } from "../access.ts";
import { chartUrl } from "../charts.ts";
import { getDb } from "../db/pool.ts";
import { isStaff, runVisibleSql } from "../db/visibility.ts";
import { getLatestPublishedRun } from "./runs.ts";
import { getPublishedRunMetadata } from "./run-metadata.ts";
import { FINAL_ALIGNMENT_VALUES, resolveDirectionAlignment, type FinalAlignment } from "./direction-shared.ts";

export { FINAL_ALIGNMENT_VALUES, type FinalAlignment };

export const DIRECTION_PAGE_SIZE = 25;

export type DirectionRow = {
  instrument_id: string;
  timeframe: "daily" | "weekly" | "monthly";
  dow_state: string | null;
  chart_object_path: string | null;
  data_quality: string | null;
  computed_at: string;
  wave: {
    structureType: string;
    currentWave: string;
    state: string;
    confidence: string;
    invalidationPrice: number | null;
  } | null;
};

export type DirectionByTimeframe = Record<"daily" | "weekly" | "monthly", DirectionRow | null>;

export type StockDirection = {
  instrumentId: string;
  symbol: string;
  name: string | null;
  updatedAt: string | null;
  finalAlignment: FinalAlignment;
  timeframes: DirectionByTimeframe;
  chartUrls: Record<"daily" | "weekly" | "monthly", string | null>;
  patterns: Array<{ name: string; direction: string; state: string; timeframe: string }>;
  dataStatus: string;
  runCutoff: string | null;
};

export type DirectionPageResult = {
  runId: string;
  runDate: string;
  runCutoff: string | null;
  rows: StockDirection[];
  totalCount: number;
  page: number;
  pageSize: number;
  pageCount: number;
};

/**
 * Bounded Direction listing for the immutable published snapshot. Membership
 * starts from the run ledger so unavailable equities remain visible, while
 * the authoritative final alignment and all direction, wave, pattern, and
 * chart evidence are read from tables scoped to that same published run.
 * Signed chart URLs are created only for the current page.
 */
export async function getDirectionPage({
  page = 1,
  pageSize = DIRECTION_PAGE_SIZE,
  query = "",
  alignment = "all",
}: {
  page?: number;
  pageSize?: number;
  query?: string;
  alignment?: FinalAlignment | "all";
} = {}): Promise<DirectionPageResult | null> {
  const run = await getLatestPublishedRun();
  if (!run) return null;
  const runCutoff = getPublishedRunMetadata(
    run as unknown as Parameters<typeof getPublishedRunMetadata>[0]
  ).cutoff;
  const viewer = await currentViewer();
  const staff = isStaff(viewer);
  const db = getDb();

  const [ledgerRows, alignmentRows] = await Promise.all([
    db.query<{
      instrument_id: string;
      terminal_state: string;
      tier: string | null;
      data_quality: string | null;
      instruments: { symbol: string; name: string | null; is_index: boolean };
    }>(
      `select r.instrument_id, r.terminal_state, r.tier, r.data_quality,
              json_build_object('symbol', i.symbol, 'name', i.name, 'is_index', i.is_index) as instruments
         from instrument_run_results r
         join instruments i on i.id = r.instrument_id
        where r.run_id = $1 and r.is_index = false and ${runVisibleSql("r", "$2")}`,
      [run.id, staff],
    ),
    db.query<{ instrument_id: string; final_alignment: FinalAlignment; computed_at: string }>(
      `select a.instrument_id, a.final_alignment, a.computed_at
         from instrument_alignment a
        where a.run_id = $1 and ${runVisibleSql("a", "$2")}`,
      [run.id, staff],
    ),
  ]);

  type LedgerRow = {
    instrument_id: string;
    terminal_state: string;
    tier: string | null;
    data_quality: string | null;
    instruments: { symbol: string; name: string | null; is_index: boolean };
  };
  type AlignmentRow = { instrument_id: string; final_alignment: FinalAlignment; computed_at: string };
  const alignmentById = new Map((alignmentRows as AlignmentRow[]).map((row) => [row.instrument_id, row]));
  const fallbackAlignment = (row: LedgerRow): FinalAlignment => resolveDirectionAlignment({
    persisted: alignmentById.get(row.instrument_id)?.final_alignment,
    terminalState: row.terminal_state,
    tier: row.tier,
    dataQuality: row.data_quality,
  });
  const normalizedQuery = query.trim().toLocaleLowerCase();
  const filtered = (ledgerRows as unknown as LedgerRow[])
    .filter((row) => !row.instruments.is_index)
    .filter((row) =>
      normalizedQuery
        ? `${row.instrument_id} ${row.instruments.symbol} ${row.instruments.name ?? ""}`.toLocaleLowerCase().includes(normalizedQuery)
        : true
    )
    .filter((row) => alignment === "all" || (alignmentById.get(row.instrument_id)?.final_alignment ?? fallbackAlignment(row)) === alignment)
    .sort((a, b) => a.instruments.symbol.localeCompare(b.instruments.symbol));
  const safePageSize = Math.max(1, Math.min(100, pageSize));
  const pageCount = Math.max(1, Math.ceil(filtered.length / safePageSize));
  const safePage = Math.min(Math.max(1, page), pageCount);
  const rowsIn = filtered.slice((safePage - 1) * safePageSize, safePage * safePageSize);
  const totalCount = filtered.length;
  const instrumentIds = rowsIn.map((row) => row.instrument_id);
  if (instrumentIds.length === 0) {
    return { runId: run.id, runDate: run.run_date, runCutoff, rows: [], totalCount, page: safePage, pageSize: safePageSize, pageCount };
  }

  const [directionRows, waveRows, patternRows] = await Promise.all([
    db.query<DirectionRow>(
      `select d.instrument_id, d.timeframe, d.dow_state, d.chart_object_path, d.data_quality, d.computed_at
         from instrument_direction_runs d
        where d.run_id = $1 and d.instrument_id = any($2::text[]) and ${runVisibleSql("d", "$3")}`,
      [run.id, instrumentIds, staff],
    ),
    db.query<{
      instrument_id: string;
      timeframe: string;
      structure_type: string;
      current_wave: string;
      wave_state: string;
      confidence: string;
      invalidation_price: number | null;
    }>(
      `select e.instrument_id, e.timeframe, e.structure_type, e.current_wave, e.wave_state, e.confidence, e.invalidation_price
         from elliott_hypotheses e
        where e.run_id = $1 and e.rank = 'primary' and e.instrument_id = any($2::text[]) and ${runVisibleSql("e", "$3")}`,
      [run.id, instrumentIds, staff],
    ),
    db.query<{ instrument_id: string; timeframe: string; pattern_name: string; direction: string; state: string }>(
      `select p.instrument_id, p.timeframe, p.pattern_name, p.direction, p.state
         from pattern_detections p
        where p.run_id = $1 and p.instrument_id = any($2::text[])
          and p.state in ('TRIGGERED', 'OBSERVED', 'MANUAL_REVIEW') and ${runVisibleSql("p", "$3")}`,
      [run.id, instrumentIds, staff],
    ),
  ]);

  const waveByKey = new Map<string, DirectionRow["wave"]>();
  for (const wave of waveRows) {
    waveByKey.set(`${wave.instrument_id}:${wave.timeframe}`, {
      structureType: wave.structure_type,
      currentWave: wave.current_wave,
      state: wave.wave_state,
      confidence: wave.confidence,
      invalidationPrice: wave.invalidation_price,
    });
  }

  const directionByInstrument = new Map<string, DirectionRow[]>();
  for (const raw of directionRows) {
    const row = { ...raw, wave: waveByKey.get(`${raw.instrument_id}:${raw.timeframe}`) ?? null };
    if (!directionByInstrument.has(row.instrument_id)) directionByInstrument.set(row.instrument_id, []);
    directionByInstrument.get(row.instrument_id)!.push(row);
  }

  const patternsByInstrument = new Map<string, StockDirection["patterns"]>();
  for (const pattern of patternRows) {
    const current = patternsByInstrument.get(pattern.instrument_id) ?? [];
    current.push({ name: pattern.pattern_name, direction: pattern.direction, state: pattern.state, timeframe: pattern.timeframe });
    patternsByInstrument.set(pattern.instrument_id, current);
  }

  // Charts are served by the authenticated /api/charts route; only this page's rows get URLs.
  const rows: StockDirection[] = rowsIn.map((r) => {
    const timeframes: DirectionByTimeframe = { daily: null, weekly: null, monthly: null };
    const chartUrls: StockDirection["chartUrls"] = { daily: null, weekly: null, monthly: null };
    let updatedAt: string | null = alignmentById.get(r.instrument_id)?.computed_at ?? null;

    for (const row of directionByInstrument.get(r.instrument_id) ?? []) {
      timeframes[row.timeframe] = row;
      chartUrls[row.timeframe] = row.chart_object_path ? chartUrl(row.chart_object_path) : null;
      if (!updatedAt || row.computed_at > updatedAt) updatedAt = row.computed_at;
    }

    return {
      instrumentId: r.instrument_id,
      symbol: r.instruments.symbol,
      name: r.instruments.name,
      updatedAt,
      finalAlignment: fallbackAlignment(r),
      timeframes,
      chartUrls,
      patterns: patternsByInstrument.get(r.instrument_id) ?? [],
      dataStatus: r.data_quality ?? "NO_DATA",
      runCutoff,
    };
  });

  return { runId: run.id, runDate: run.run_date, runCutoff, rows, totalCount, page: safePage, pageSize: safePageSize, pageCount };
}

/** Same immutable published-run shape for the stock detail page. */
export async function getDirectionForInstrument(instrumentId: string): Promise<StockDirection | null> {
  const result = await getDirectionPage({ page: 1, pageSize: 100, query: instrumentId });
  return result?.rows.find((row) => row.instrumentId === instrumentId) ?? null;
}

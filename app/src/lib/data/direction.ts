import { createClient } from "@/lib/supabase/server";
import { getLatestPublishedRun } from "@/lib/data/runs";
import { getPublishedRunMetadata } from "@/lib/data/run-metadata";
import { FINAL_ALIGNMENT_VALUES, resolveDirectionAlignment, type FinalAlignment } from "@/lib/data/direction-shared";

export { FINAL_ALIGNMENT_VALUES, type FinalAlignment };

const SIGNED_URL_TTL_SECONDS = 60 * 60; // 1 hour -- regenerated on every page load, not cached
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
  const supabase = await createClient();

  const [{ data: ledgerRows, error: ledgerError }, { data: alignmentRows, error: alignmentError }] = await Promise.all([
    supabase
      .from("instrument_run_results")
      .select("instrument_id, terminal_state, tier, data_quality, instruments!inner(symbol, name, is_index)")
      .eq("run_id", run.id)
      .eq("is_index", false),
    supabase.from("instrument_alignment").select("instrument_id, final_alignment, computed_at").eq("run_id", run.id),
  ]);
  if (ledgerError) throw ledgerError;
  if (alignmentError) throw alignmentError;

  type LedgerRow = {
    instrument_id: string;
    terminal_state: string;
    tier: string | null;
    data_quality: string | null;
    instruments: { symbol: string; name: string | null; is_index: boolean };
  };
  type AlignmentRow = { instrument_id: string; final_alignment: FinalAlignment; computed_at: string };
  const alignmentById = new Map(((alignmentRows ?? []) as AlignmentRow[]).map((row) => [row.instrument_id, row]));
  const fallbackAlignment = (row: LedgerRow): FinalAlignment => resolveDirectionAlignment({
    persisted: alignmentById.get(row.instrument_id)?.final_alignment,
    terminalState: row.terminal_state,
    tier: row.tier,
    dataQuality: row.data_quality,
  });
  const normalizedQuery = query.trim().toLocaleLowerCase();
  const filtered = ((ledgerRows ?? []) as unknown as LedgerRow[])
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

  const [directionResponse, waveResponse, patternResponse] = await Promise.all([
    supabase
      .from("instrument_direction_runs")
      .select("instrument_id, timeframe, dow_state, chart_object_path, data_quality, computed_at")
      .eq("run_id", run.id)
      .in("instrument_id", instrumentIds),
    supabase
      .from("elliott_hypotheses")
      .select("instrument_id, timeframe, structure_type, current_wave, wave_state, confidence, invalidation_price")
      .eq("run_id", run.id)
      .eq("rank", "primary")
      .in("instrument_id", instrumentIds),
    supabase
      .from("pattern_detections")
      .select("instrument_id, timeframe, pattern_name, direction, state")
      .eq("run_id", run.id)
      .in("instrument_id", instrumentIds)
      .in("state", ["TRIGGERED", "OBSERVED", "MANUAL_REVIEW"]),
  ]);
  if (directionResponse.error) throw directionResponse.error;
  if (waveResponse.error) throw waveResponse.error;
  if (patternResponse.error) throw patternResponse.error;

  const waveByKey = new Map<string, DirectionRow["wave"]>();
  for (const wave of waveResponse.data ?? []) {
    waveByKey.set(`${wave.instrument_id}:${wave.timeframe}`, {
      structureType: wave.structure_type,
      currentWave: wave.current_wave,
      state: wave.wave_state,
      confidence: wave.confidence,
      invalidationPrice: wave.invalidation_price,
    });
  }

  const directionByInstrument = new Map<string, DirectionRow[]>();
  for (const raw of (directionResponse.data ?? []) as unknown as DirectionRow[]) {
    const row = { ...raw, wave: waveByKey.get(`${raw.instrument_id}:${raw.timeframe}`) ?? null };
    if (!directionByInstrument.has(row.instrument_id)) directionByInstrument.set(row.instrument_id, []);
    directionByInstrument.get(row.instrument_id)!.push(row);
  }

  const patternsByInstrument = new Map<string, StockDirection["patterns"]>();
  for (const pattern of patternResponse.data ?? []) {
    const current = patternsByInstrument.get(pattern.instrument_id) ?? [];
    current.push({ name: pattern.pattern_name, direction: pattern.direction, state: pattern.state, timeframe: pattern.timeframe });
    patternsByInstrument.set(pattern.instrument_id, current);
  }

  // Lazy charts (#25): only this page's rows ever get a signed URL request,
  // not the whole universe's.
  const paths = [...new Set((directionResponse.data ?? []).map((r) => r.chart_object_path).filter((p): p is string => !!p))];
  const signedUrlByPath = new Map<string, string>();
  if (paths.length > 0) {
    const { data: signed } = await supabase.storage.from("direction-charts").createSignedUrls(paths, SIGNED_URL_TTL_SECONDS);
    for (const s of signed ?? []) {
      if (s.path && s.signedUrl) signedUrlByPath.set(s.path, s.signedUrl);
    }
  }

  const rows: StockDirection[] = rowsIn.map((r) => {
    const timeframes: DirectionByTimeframe = { daily: null, weekly: null, monthly: null };
    const chartUrls: StockDirection["chartUrls"] = { daily: null, weekly: null, monthly: null };
    let updatedAt: string | null = alignmentById.get(r.instrument_id)?.computed_at ?? null;

    for (const row of directionByInstrument.get(r.instrument_id) ?? []) {
      timeframes[row.timeframe] = row;
      chartUrls[row.timeframe] = row.chart_object_path ? signedUrlByPath.get(row.chart_object_path) ?? null : null;
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

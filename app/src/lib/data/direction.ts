import { createClient } from "@/lib/supabase/server";
import { getLatestPublishedRun } from "@/lib/data/runs";
import { FINAL_ALIGNMENT_VALUES, type FinalAlignment } from "@/lib/data/direction-shared";

export { FINAL_ALIGNMENT_VALUES, type FinalAlignment };

const SIGNED_URL_TTL_SECONDS = 60 * 60; // 1 hour -- regenerated on every page load, not cached
export const DIRECTION_PAGE_SIZE = 25;

export type DirectionRow = {
  instrument_id: string;
  timeframe: "daily" | "weekly" | "monthly";
  dow_state: string | null;
  wave_label: string | null;
  wave_confidence: string | null;
  chart_object_path: string | null;
  data_quality: string | null;
  updated_at: string;
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
};

export type DirectionPageResult = {
  runId: string;
  runDate: string;
  rows: StockDirection[];
  totalCount: number;
  page: number;
  pageSize: number;
  pageCount: number;
};

/**
 * Server-paginated, server-filtered Direction listing, scoped to a single
 * run_id throughout -- closes architecture-plan.md problems #1 (confluence
 * computed client-side from raw dow_state strings), #6 (no run_id coherence
 * check across a stock's 3 timeframe rows -- a stale daily row from an
 * older run could silently get mixed with a fresh weekly/monthly one), and
 * #25 (every chart's signed URL requested in one shot, ~1,500 at full
 * coverage). final_alignment comes from instrument_alignment
 * (features/alignment.js's computeFinalAlignment, run server-side) rather
 * than being re-derived here.
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

  const supabase = await createClient();

  let alignmentQuery = supabase
    .from("instrument_alignment")
    .select("instrument_id, final_alignment, computed_at, instruments!inner(symbol, name, is_index)", {
      count: "exact",
    })
    .eq("run_id", run.id)
    .eq("instruments.is_index", false);

  if (alignment !== "all") {
    alignmentQuery = alignmentQuery.eq("final_alignment", alignment);
  }
  const trimmedQuery = query.trim();
  if (trimmedQuery) {
    const like = `%${trimmedQuery}%`;
    alignmentQuery = alignmentQuery.or(`symbol.ilike.${like},name.ilike.${like}`, { referencedTable: "instruments" });
  }

  const safePage = Math.max(1, page);
  const from = (safePage - 1) * pageSize;
  const to = from + pageSize - 1;

  const { data: alignmentRows, error: alignmentError, count } = await alignmentQuery
    .order("symbol", { referencedTable: "instruments", ascending: true })
    .range(from, to);
  if (alignmentError) throw alignmentError;

  const totalCount = count ?? 0;
  const pageCount = Math.max(1, Math.ceil(totalCount / pageSize));

  const rowsIn = (alignmentRows ?? []) as unknown as {
    instrument_id: string;
    final_alignment: FinalAlignment;
    instruments: { symbol: string; name: string | null };
  }[];

  if (rowsIn.length === 0) {
    return { runId: run.id, runDate: run.run_date, rows: [], totalCount, page: safePage, pageSize, pageCount };
  }

  const instrumentIds = rowsIn.map((r) => r.instrument_id);
  const { data: directionRows, error: directionError } = await supabase
    .from("instrument_direction")
    .select("instrument_id, timeframe, dow_state, wave_label, wave_confidence, chart_object_path, data_quality, updated_at")
    .eq("run_id", run.id)
    .in("instrument_id", instrumentIds);
  if (directionError) throw directionError;

  const directionByInstrument = new Map<string, DirectionRow[]>();
  for (const row of (directionRows ?? []) as DirectionRow[]) {
    if (!directionByInstrument.has(row.instrument_id)) directionByInstrument.set(row.instrument_id, []);
    directionByInstrument.get(row.instrument_id)!.push(row);
  }

  // Lazy charts (#25): only this page's rows ever get a signed URL request,
  // not the whole universe's.
  const paths = (directionRows ?? []).map((r) => r.chart_object_path).filter((p): p is string => !!p);
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
    let updatedAt: string | null = null;

    for (const row of directionByInstrument.get(r.instrument_id) ?? []) {
      timeframes[row.timeframe] = row;
      chartUrls[row.timeframe] = row.chart_object_path ? signedUrlByPath.get(row.chart_object_path) ?? null : null;
      if (!updatedAt || row.updated_at > updatedAt) updatedAt = row.updated_at;
    }

    return {
      instrumentId: r.instrument_id,
      symbol: r.instruments.symbol,
      name: r.instruments.name,
      updatedAt,
      finalAlignment: r.final_alignment,
      timeframes,
      chartUrls,
    };
  });

  return { runId: run.id, runDate: run.run_date, rows, totalCount, page: safePage, pageSize, pageCount };
}

/**
 * Same shape, scoped to one instrument and the latest published run -- for
 * the stock detail page's Direction section. Unlike the old version, this
 * only ever returns data if the instrument was actually part of that run
 * (via instrument_alignment), rather than whatever instrument_direction
 * happened to hold last regardless of which run wrote it (#6).
 */
export async function getDirectionForInstrument(instrumentId: string): Promise<StockDirection | null> {
  const run = await getLatestPublishedRun();
  if (!run) return null;

  const supabase = await createClient();
  const { data: alignmentRow, error: alignmentError } = await supabase
    .from("instrument_alignment")
    .select("instrument_id, final_alignment")
    .eq("run_id", run.id)
    .eq("instrument_id", instrumentId)
    .maybeSingle();
  if (alignmentError) throw alignmentError;
  if (!alignmentRow) return null;

  const { data: instrument, error: instrumentError } = await supabase
    .from("instruments")
    .select("symbol, name")
    .eq("id", instrumentId)
    .maybeSingle();
  if (instrumentError) throw instrumentError;
  if (!instrument) return null;

  const { data: directionRows, error: directionError } = await supabase
    .from("instrument_direction")
    .select("instrument_id, timeframe, dow_state, wave_label, wave_confidence, chart_object_path, data_quality, updated_at")
    .eq("run_id", run.id)
    .eq("instrument_id", instrumentId);
  if (directionError) throw directionError;

  const paths = (directionRows ?? []).map((r) => r.chart_object_path).filter((p): p is string => !!p);
  const signedUrlByPath = new Map<string, string>();
  if (paths.length > 0) {
    const { data: signed } = await supabase.storage.from("direction-charts").createSignedUrls(paths, SIGNED_URL_TTL_SECONDS);
    for (const s of signed ?? []) {
      if (s.path && s.signedUrl) signedUrlByPath.set(s.path, s.signedUrl);
    }
  }

  const timeframes: DirectionByTimeframe = { daily: null, weekly: null, monthly: null };
  const chartUrls: StockDirection["chartUrls"] = { daily: null, weekly: null, monthly: null };
  let updatedAt: string | null = null;
  for (const row of (directionRows ?? []) as DirectionRow[]) {
    timeframes[row.timeframe] = row;
    chartUrls[row.timeframe] = row.chart_object_path ? signedUrlByPath.get(row.chart_object_path) ?? null : null;
    if (!updatedAt || row.updated_at > updatedAt) updatedAt = row.updated_at;
  }

  return {
    instrumentId,
    symbol: instrument.symbol,
    name: instrument.name,
    updatedAt,
    finalAlignment: alignmentRow.final_alignment as FinalAlignment,
    timeframes,
    chartUrls,
  };
}

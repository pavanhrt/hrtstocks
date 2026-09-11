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
 * Server-paginated, server-filtered Direction listing -- closes
 * architecture-plan.md problems #1 (confluence computed client-side from
 * raw dow_state strings) and #25 (every chart's signed URL requested in one
 * shot, ~1,500 at full coverage). final_alignment comes from
 * instrument_alignment (features/alignment.js's computeFinalAlignment, run
 * server-side, one immutable row per (run_id, instrument_id) -- never
 * overwritten by a later run) rather than being re-derived here; pagination
 * and the confluence filter are scoped to `run.id`, the latest run with
 * status='completed'.
 *
 * `instrument_direction` (Monthly/Weekly/Daily dow_state + chart) is
 * deliberately NOT filtered by that same run_id. It is a genuine
 * latest-state table -- index.ts's upsertDirectionAnalysis writes it with
 * `onConflict: "instrument_id,timeframe"` (no run_id in the unique key), so
 * ANY run that later processes an instrument -- including one that never
 * gets published (ends 'partial'/'failed') -- stamps its own run_id over
 * that instrument's row. An earlier version of this function filtered
 * `instrument_direction` by the page's own `run.id` to fix problem #6 (a
 * stale daily row from an older run silently blending with a fresh
 * weekly/monthly one) -- but that assumed run_id was a stable per-run key on
 * a table whose own write path never guaranteed that, and it fails exactly
 * the way problem #6's fix was supposed to prevent: the instant a newer,
 * not-yet-published run touches even one instrument, every OTHER instrument
 * whose row still carries the older published run_id keeps showing real
 * data, while every instrument the newer run DID reach vanishes from the
 * query entirely (confirmed live 2026-09-11: a manually-triggered run that
 * ended 'partial' overwrote ~497 of 501 instruments' run_id, and the page
 * rendered "Unavailable" for all of them even though their dow_state/chart
 * data was completely current). Problem #6's real guarantee -- an
 * instrument's own daily/weekly/monthly rows never blend across two
 * different runs -- already holds independently of any run_id filter here:
 * upsertDirectionAnalysis processes all 3 timeframes for one instrument
 * together, in the same call, every time that instrument gets a fresh
 * dataQuality=PASS evaluation, so its 3 rows are always stamped by the same
 * run as each other. Reading this table as pure latest-state (instrument_id
 * only) is therefore both simpler and more honest than the run_id-filtered
 * version: an instrument touched only by an older run still shows its real,
 * current-as-of-that-run data (with its own real `updated_at`) instead of
 * silently disappearing. The properly run-scoped equivalent, if a strict
 * per-run snapshot is ever needed again, is instrument_direction_runs
 * (migration 0006, unique on `run_id, instrument_id, timeframe` -- never
 * overwritten by a different run) -- not used here today.
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
 * Same shape, for the stock detail page's Direction section.
 * `final_alignment` is still scoped to the latest published run (via
 * instrument_alignment, and this returns null if the instrument wasn't part
 * of that run at all), but `instrument_direction` itself is read as pure
 * latest-state, not filtered by that run's id -- see getDirectionPage's own
 * header comment for why a run_id filter on this specific table causes real
 * data to silently disappear the moment any later (even unpublished) run
 * touches the instrument.
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

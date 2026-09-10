import { createClient } from "@/lib/supabase/server";

const SIGNED_URL_TTL_SECONDS = 60 * 60; // 1 hour -- regenerated on every page load, not cached

export type DirectionRow = {
  instrument_id: string;
  timeframe: "daily" | "weekly" | "monthly";
  dow_state: string | null;
  wave_label: string | null;
  wave_confidence: string | null;
  chart_object_path: string | null;
  data_quality: string | null;
  updated_at: string;
  instruments: { symbol: string; name: string | null } | null;
};

export type DirectionByTimeframe = Record<"daily" | "weekly" | "monthly", DirectionRow | null>;

export type StockDirection = {
  instrumentId: string;
  symbol: string;
  name: string | null;
  updatedAt: string | null;
  timeframes: DirectionByTimeframe;
  chartUrls: Record<"daily" | "weekly" | "monthly", string | null>;
};

/** One row per (stock, timeframe) for every non-index instrument, grouped and joined to signed chart URLs. */
export async function getDirectionAnalysis(): Promise<StockDirection[]> {
  const supabase = await createClient();
  const { data, error } = await supabase
    .from("instrument_direction")
    .select("*, instruments!inner(symbol, name, is_index)")
    .eq("instruments.is_index", false)
    .order("instrument_id", { ascending: true });
  if (error) throw error;

  return groupAndSign(supabase, (data ?? []) as unknown as (DirectionRow & { instruments: { symbol: string; name: string | null } })[]);
}

/** Same shape, scoped to one instrument -- for the stock detail page's Direction section. */
export async function getDirectionForInstrument(instrumentId: string): Promise<StockDirection | null> {
  const supabase = await createClient();
  const { data, error } = await supabase
    .from("instrument_direction")
    .select("*, instruments(symbol, name)")
    .eq("instrument_id", instrumentId);
  if (error) throw error;
  if (!data || data.length === 0) return null;

  const grouped = await groupAndSign(supabase, data as unknown as (DirectionRow & { instruments: { symbol: string; name: string | null } })[]);
  return grouped[0] ?? null;
}

async function groupAndSign(
  supabase: Awaited<ReturnType<typeof createClient>>,
  rows: (DirectionRow & { instruments: { symbol: string; name: string | null } })[]
): Promise<StockDirection[]> {
  const byInstrument = new Map<string, (DirectionRow & { instruments: { symbol: string; name: string | null } })[]>();
  for (const row of rows) {
    if (!byInstrument.has(row.instrument_id)) byInstrument.set(row.instrument_id, []);
    byInstrument.get(row.instrument_id)!.push(row);
  }

  const paths = rows.map((r) => r.chart_object_path).filter((p): p is string => !!p);
  const signedUrlByPath = new Map<string, string>();
  if (paths.length > 0) {
    const { data: signed } = await supabase.storage.from("direction-charts").createSignedUrls(paths, SIGNED_URL_TTL_SECONDS);
    for (const s of signed ?? []) {
      if (s.path && s.signedUrl) signedUrlByPath.set(s.path, s.signedUrl);
    }
  }

  const out: StockDirection[] = [];
  for (const [instrumentId, instrumentRows] of byInstrument) {
    const first = instrumentRows[0];
    const timeframes: DirectionByTimeframe = { daily: null, weekly: null, monthly: null };
    const chartUrls: StockDirection["chartUrls"] = { daily: null, weekly: null, monthly: null };
    let updatedAt: string | null = null;

    for (const row of instrumentRows) {
      timeframes[row.timeframe] = row;
      chartUrls[row.timeframe] = row.chart_object_path ? signedUrlByPath.get(row.chart_object_path) ?? null : null;
      if (!updatedAt || row.updated_at > updatedAt) updatedAt = row.updated_at;
    }

    out.push({
      instrumentId,
      symbol: first.instruments.symbol,
      name: first.instruments.name,
      updatedAt,
      timeframes,
      chartUrls,
    });
  }

  out.sort((a, b) => a.symbol.localeCompare(b.symbol));
  return out;
}

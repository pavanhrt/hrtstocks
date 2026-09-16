// Pure sort-spec resolution for /buy-setup-analysis's main table -- kept
// separate from buy-setup-analysis.ts (which imports @/lib/supabase/server
// and therefore can't run under plain `node --test`) so this is directly
// unit-testable, the same reason buy-setup-status.ts exists on its own.
//
// Correction (2026-09-16): sorting by fundamental_score must always put a
// resolved numeric score before NO_DATA/null, in EITHER direction --
// Postgres' own default NULLS ordering (NULLS LAST for ascending, NULLS
// FIRST for descending) would otherwise put every NO_DATA row first when
// sorting descending, burying every actually-scored stock at the bottom of
// the "highest score first" view.

export type SortableColumn = "symbol" | "overall_status" | "gate_result" | "fundamental_score" | "instrument_id";

export type SortSpec = {
  column: SortableColumn;
  ascending: boolean;
  nullsFirst: boolean;
};

const NULLABLE_COLUMNS: ReadonlySet<SortableColumn> = new Set(["fundamental_score"]);

export function resolveSortColumn(sortBy: string | undefined): SortableColumn {
  if (sortBy === "overall_status" || sortBy === "gate_result" || sortBy === "fundamental_score") return sortBy;
  return "symbol";
}

/** The primary sort spec plus a stable `instrument_id` tie-breaker, applied in order. */
export function buildSortSpecs(sortBy: string | undefined, sortDirection: string | undefined): [SortSpec, SortSpec] {
  const column = resolveSortColumn(sortBy);
  const ascending = (sortDirection ?? "asc") === "asc";
  // A numeric score must sort before NO_DATA/null regardless of direction:
  // nullsFirst=false for BOTH ascending and descending on a nullable column.
  const nullsFirst = NULLABLE_COLUMNS.has(column) ? false : !ascending;
  return [
    { column, ascending, nullsFirst },
    { column: "instrument_id", ascending: true, nullsFirst: false },
  ];
}

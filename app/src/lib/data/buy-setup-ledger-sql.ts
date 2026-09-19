import type { SortSpec } from "./buy-setup-sort.ts";

// Pure SQL construction for the /buy-setup-analysis ledger (view
// buy_setup_analysis_ledger). Kept free of imports beyond a type so it is
// unit-testable under plain `node --test`, and so every value reaches Postgres
// as a bound parameter -- filters never interpolate user input into SQL text.

export type LedgerFilters = {
  query?: string;
  monthlyState?: string;
  weeklyState?: string;
  dailyState?: string;
  gate?: string;
  wave?: string;
  reversal?: string;
  overallStatus?: string;
  dataAvailability?: string;
  minFundamentalScore?: number;
  fundamentalDataStatus?: string;
};

const LIKE_ESCAPE = "\\";
const escapeLike = (s: string) => s.replace(/[\\%_]/g, (c) => LIKE_ESCAPE + c);

/**
 * Non-staff viewers must not see fundamentals from unpublished refresh
 * manifests (a former RLS rule). This expression is the score they may see.
 */
export const VISIBLE_FUNDAMENTAL_SCORE = (staffParam: string) =>
  `case when (${staffParam}::boolean or fundamental_result_published) then fundamental_score end`;
export const VISIBLE_FUNDAMENTAL_STATUS = (staffParam: string) =>
  `case when (${staffParam}::boolean or fundamental_result_published) then fundamental_data_status end`;

// Only these ledger columns may ever appear in ORDER BY.
const ORDER_COLUMNS: Record<SortSpec["column"], (staffParam: string) => string> = {
  symbol: () => "symbol",
  overall_status: () => "overall_status",
  gate_result: () => "gate_result",
  instrument_id: () => "instrument_id",
  fundamental_score: VISIBLE_FUNDAMENTAL_SCORE,
};

/**
 * WHERE clause for a run's ledger rows. $1 = run id and $2 = staff flag are
 * always bound; any further parameters are appended to `params`.
 */
export function buildLedgerWhere(filters: LedgerFilters): { where: string; params: unknown[] } {
  const params: unknown[] = [];
  const bind = (value: unknown) => {
    params.push(value);
    return `$${params.length + 2}`; // $1 run id, $2 staff flag precede these
  };
  const conditions = ["run_id = $1"];

  const q = (filters.query ?? "").trim().slice(0, 64);
  if (q) {
    const pattern = bind(`%${escapeLike(q)}%`);
    const esc = bind(LIKE_ESCAPE);
    conditions.push(`(symbol ilike ${pattern} escape ${esc} or name ilike ${pattern} escape ${esc} or instrument_id ilike ${pattern} escape ${esc})`);
  }
  const eq = (column: string, value: string | undefined) => {
    if (value && value !== "all") conditions.push(`${column} = ${bind(value)}`);
  };
  eq("monthly_dow_state", filters.monthlyState);
  eq("weekly_dow_state", filters.weeklyState);
  eq("daily_dow_state", filters.dailyState);
  eq("gate_result", filters.gate);
  eq("fifteen_min_wave", filters.wave);
  if (filters.reversal === "rsi_pass") conditions.push("rsi_reversal_result = 'PASS'");
  if (filters.reversal === "macd_pass") conditions.push("macd_reversal_result = 'PASS'");
  if (filters.reversal === "either_pass") conditions.push("(rsi_reversal_result = 'PASS' or macd_reversal_result = 'PASS')");
  // PostgREST's `not.eq` is `NOT (col = 'PASS')`, which excludes NULLs; keep those semantics.
  if (filters.reversal === "none") conditions.push("(not (rsi_reversal_result = 'PASS') and not (macd_reversal_result = 'PASS'))");
  eq("overall_status", filters.overallStatus);
  if (filters.dataAvailability === "has_data") conditions.push("not (overall_status = 'NO_DATA')");
  if (filters.dataAvailability === "no_data") conditions.push("overall_status = 'NO_DATA'");
  if (filters.minFundamentalScore != null && Number.isFinite(filters.minFundamentalScore)) {
    conditions.push(`${VISIBLE_FUNDAMENTAL_SCORE("$2")} >= ${bind(filters.minFundamentalScore)}`);
  }
  if (filters.fundamentalDataStatus && filters.fundamentalDataStatus !== "all") {
    conditions.push(`${VISIBLE_FUNDAMENTAL_STATUS("$2")} = ${bind(filters.fundamentalDataStatus)}`);
  }
  return { where: conditions.join(" and "), params };
}

/** ORDER BY clause from validated sort specs (column names come from a fixed allow-list, never from input). */
export function buildLedgerOrderBy(specs: readonly SortSpec[]): string {
  return specs
    .map((spec) => {
      const column = ORDER_COLUMNS[spec.column];
      if (!column) throw new Error(`Unsortable column: ${String(spec.column)}`);
      return `${column("$2")} ${spec.ascending ? "asc" : "desc"} nulls ${spec.nullsFirst ? "first" : "last"}`;
    })
    .join(", ");
}

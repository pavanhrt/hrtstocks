// Normalizes raw Upstox Company Fundamentals API responses into this
// project's own shapes: fundamental_source_snapshots-compatible records and
// metrics.js-compatible per-period financials objects. See upstox-client.js
// for the endpoint inventory and the critical publication-timestamp finding
// this file exists to handle honestly.
//
// POINT-IN-TIME HANDLING -- REVISED 2026-09-16 (timestamp-basis redesign):
// none of the inspected Upstox endpoints disclose a filing's actual
// publication timestamp -- every one returns only a period LABEL ("Mar
// 2025") or, for key-ratios, no period at all. The earlier version of this
// module set `publication_timestamp = retrievedAtIso` directly, which
// blurred "the company published this" and "we happened to retrieve it"
// into one field. Corrected: this module now produces FOUR distinct
// timestamp-related fields (matching migration 0014's revised schema):
//   - `publication_timestamp`: null for Upstox (never invented -- Upstox
//     discloses no filing date anywhere inspected).
//   - `retrieved_at`: when THIS ingestion actually fetched the data.
//   - `available_from`: the single DEFENSIBLE eligibility timestamp every
//     downstream point-in-time check (filings.js, the DB binding) actually
//     filters on -- equal to `publication_timestamp` when known, else equal
//     to `retrieved_at`. For Upstox this is always `retrieved_at`.
//   - `timestamp_basis`: `'RETRIEVAL_ONLY'` for every Upstox record (vs.
//     `'PROVIDER_PUBLICATION'`/`'EXCHANGE_FILING'` for a future provider
//     that DOES disclose a real filing date) -- an explicit, queryable
//     disclosure that this evidence may reflect restated/latest values and
//     is NOT historically point-in-time reliable; it must only ever be used
//     for a NEW screening cutoff at or after `available_from`, never
//     backfilled into an older already-published run.
//
// COVERAGE BOUNDARIES (also per instruction): Upstox's share-holdings
// endpoint discloses only promoter/FII/DII/mutual-fund/retail percentages --
// no pledge/encumbrance figure exists anywhere in the inspected API.
// mapShareholdingHistory() below therefore never attempts to derive
// promoter_pledge from Upstox data; callers must leave that sub-metric
// NO_DATA (or source it from a separate, permitted NSE pledge-disclosure
// feed once one exists -- not built here). Likewise, no Upstox endpoint
// provides dated, attributable forward-looking evidence (order book,
// capex, regulatory approval, guidance) -- future_growth must stay
// NO_DATA/MANUAL_REVIEW for any instrument sourced only from Upstox.
//
// ACCOUNTING HONESTY -- REVISED 2026-09-16 (removed two approximations that
// risked silently misrepresenting evidence):
//   - `total_debt` is NEVER populated from `total_liability` (trade
//     payables, provisions, and every other non-borrowing liability are not
//     debt). It is populated ONLY from an explicit borrowings/debt line in
//     `full_statement` (see DEBT_LINE_PARTICULARS) and is `null` otherwise
//     -- confirmed against Reliance's real balance-sheet full_statement
//     (2026-09-16), which has no such line at all, so total_debt is
//     correctly null for that company. `total_liabilities` is preserved
//     separately, unused by any debt-scoring sub-metric.
//   - `ebit` is no longer approximated as `operating_profit` -- Upstox does
//     not label any field "EBIT" anywhere inspected, so `ebit` stays `null`
//     (EBIT-dependent sub-metrics -- interest_coverage, roce -- correctly
//     read NO_DATA via metrics.js's own existing null-handling, never a
//     silently-approximated ratio). `operating_profit` is still reported
//     under its own name for the sub-metrics that genuinely use it
//     (profitability.operating_margin).
//
// AUDIT STATUS -- REVISED 2026-09-16: no inspected endpoint discloses
// whether a filing was audited, limited-review, or unaudited. `audit_status`
// is therefore `null` (undisclosed) for every Upstox-sourced snapshot --
// never defaulted to `"unaudited"` or any other value.

import { classifyUpstoxSector } from "./upstox-sector-taxonomy.js";

/**
 * @param {string|null|undefined} upstoxSector -- company_profile.data.sector
 * @returns {string|null} a value for sector-models.js's resolveSectorModel():
 *   null when Upstox disclosed nothing at all (-> NO_DATA there); the
 *   reviewed taxonomy's classified model (BANK/NBFC/NON_FINANCIAL/
 *   UNSUPPORTED_FALLBACK -- see upstox-sector-taxonomy.js) when the exact
 *   string has been reviewed; otherwise the RAW sector string unchanged so
 *   resolveSectorModel() correctly resolves an as-yet-unreviewed string to
 *   UNSUPPORTED_FALLBACK -- never silently defaulted to NON_FINANCIAL and
 *   never collapsed into NO_DATA. A KNOWN-but-unsupported sector (e.g.
 *   insurance) and a genuinely NEW/unreviewed string both resolve to
 *   UNSUPPORTED_FALLBACK identically -- both correctly become MANUAL_REVIEW
 *   at the score level (scoring.js), never NOT_APPLICABLE and never a
 *   fabricated number.
 */
export function mapUpstoxSectorToModel(upstoxSector) {
  if (!upstoxSector) return null;
  return classifyUpstoxSector(upstoxSector)?.model ?? upstoxSector;
}

/** Parses a Upstox key-ratios-style value ("8.94%", "20.15") into a plain number, or null if unparseable. */
export function parsePercentOrNumber(raw) {
  if (raw == null) return null;
  const cleaned = String(raw).replace("%", "").trim();
  const value = Number(cleaned);
  return Number.isFinite(value) ? value : null;
}

/** @param {{period:string,value:number}[]} history -- most-recent-first, per Upstox's own documented ordering. */
function byPeriod(history) {
  const map = new Map();
  for (const row of history ?? []) map.set(row.period, row.value);
  return map;
}

// Exact, reviewed particular labels that unambiguously mean interest-bearing
// debt/borrowings, never a broader "liabilities" figure. A single combined
// line ("Borrowings"/"Total Borrowings"/"Total Debt") is preferred when
// present; otherwise long-term and short-term borrowings are summed ONLY
// when BOTH are present (summing just one half would understate debt, which
// is worse than reporting NO_DATA).
const COMBINED_DEBT_PARTICULARS = ["Borrowings", "Total Borrowings", "Total Debt"];
const LONG_TERM_DEBT_PARTICULAR = "Long Term Borrowings";
const SHORT_TERM_DEBT_PARTICULAR = "Short Term Borrowings";

// REVISED 2026-09-16 -- confirmed live with `type=consolidated&fs=true`:
// the Get Cash Flow endpoint's full_statement DOES populate, with an exact,
// reviewed set of 11 particulars: "Profit before tax", "Income before WC
// changes", "Change in Assets", "Change in Liabilities", "Change in WC",
// "Cash flow from Operations", "Cash flow from Investing", "Cash flow from
// Financing", "Total Cash Flow", "Cash (Start of the year)", "Cash (End of
// the year)". Only the exact label below is ever matched -- never a fuzzy
// regex -- and only "Cash flow from Operations" is consumed, as a
// cross-check/fallback against the top-level `cash_flow` category array,
// which remains the AUTHORITATIVE source for operating/investing/financing
// totals (see resolveOperatingCashFlow below). "Cash flow from Investing" is
// deliberately never parsed from full_statement: Upstox's investing category
// (top-level or full_statement) bundles capex together with every other
// investing activity (treasury investments, acquisitions, etc.), so it is
// never usable as a clean capex figure under any label -- no
// capital_expenditure or free_cash_flow field is ever derived anywhere in
// this file, and fcf_consistency's sub-metric correctly stays NO_DATA as a
// permanent, disclosed limitation rather than an approximation.
const CASH_FLOW_FULL_STATEMENT_LABELS = Object.freeze({
  OPERATIONS: "Cash flow from Operations",
});

// A 1% relative tolerance (floored at 1 Crore to absorb rounding noise) --
// generous enough that ordinary rounding between the two independently
// -reported figures never falsely triggers MANUAL_REVIEW, tight enough that
// a genuine data-quality conflict (the two sources describing different
// underlying figures) is never silently averaged away or arbitrarily
// resolved by picking one.
const CASH_FLOW_RELATIVE_TOLERANCE = 0.01;
const CASH_FLOW_ABSOLUTE_FLOOR_CRORE = 1;

function cashFlowValuesMateriallyDisagree(a, b) {
  const diff = Math.abs(a - b);
  const scale = Math.max(Math.abs(a), Math.abs(b));
  return diff > Math.max(CASH_FLOW_ABSOLUTE_FLOOR_CRORE, CASH_FLOW_RELATIVE_TOLERANCE * scale);
}

/**
 * Resolves ONE period's operating cash flow from the two independent Upstox
 * sources, per the task's own explicit rule: the top-level `cash_flow`
 * category array is authoritative; full_statement's "Cash flow from
 * Operations" may be used as a cross-check, or as a fallback ONLY when the
 * top-level value is absent. When both exist and materially disagree,
 * neither is silently chosen -- the resolved value is null (MANUAL_REVIEW at
 * the metrics layer, via deriveOcfToPat/deriveCashConversion's
 * `ocfProvenance` parameter) and BOTH raw values are preserved on the
 * returned per-period object for the evidence table.
 * @returns {{value: number|null, provenance: 'TOP_LEVEL'|'FULL_STATEMENT_FALLBACK'|'DISAGREEMENT'|null}}
 */
function resolveOperatingCashFlow(topLevelValue, fullStatementValue) {
  if (topLevelValue != null && fullStatementValue != null) {
    if (cashFlowValuesMateriallyDisagree(topLevelValue, fullStatementValue)) {
      return { value: null, provenance: "DISAGREEMENT" };
    }
    return { value: topLevelValue, provenance: "TOP_LEVEL" };
  }
  if (topLevelValue != null) return { value: topLevelValue, provenance: "TOP_LEVEL" };
  if (fullStatementValue != null) return { value: fullStatementValue, provenance: "FULL_STATEMENT_FALLBACK" };
  return { value: null, provenance: null };
}

/** @param {Map<string, Map<string, number>>} fullStatementByParticular @returns {Map<string, number>|null} period -> total debt, or null if no explicit debt line exists at all. */
function resolveDebtLine(fullStatementByParticular) {
  for (const label of COMBINED_DEBT_PARTICULARS) {
    const line = fullStatementByParticular.get(label);
    if (line) return line;
  }
  const longTerm = fullStatementByParticular.get(LONG_TERM_DEBT_PARTICULAR);
  const shortTerm = fullStatementByParticular.get(SHORT_TERM_DEBT_PARTICULAR);
  if (longTerm && shortTerm) {
    const combined = new Map();
    for (const period of longTerm.keys()) {
      if (shortTerm.has(period)) combined.set(period, longTerm.get(period) + shortTerm.get(period));
    }
    return combined;
  }
  return null; // no explicit debt line at all -- total_debt stays null (NO_DATA), never approximated from total_liability
}

/**
 * Builds one metrics.js-compatible financials object per period, from raw
 * balance-sheet + income-statement + cash-flow responses for the SAME
 * consolidation type. Only periods present in the balance sheet are
 * emitted (the anchor statement); a period missing from income-statement or
 * cash-flow simply leaves those specific fields undefined for that period,
 * which every metrics.js deriver already treats as NO_DATA (never zero).
 *
 * Units: Upstox reports every monetary figure in Crore -- kept in Crore
 * throughout (never converted to absolute rupees), since every metrics.js
 * formula is either a ratio (scale-invariant) or a CAGR (scale-invariant);
 * only a raw absolute value would need conversion, and none of this
 * project's sub-metrics consume one.
 *
 * @returns {Map<string, object>} period label ("Mar 2025") -> financials object
 */
export function buildPeriodFinancials({ balanceSheet, incomeStatement, cashFlow }) {
  const byPeriodResult = new Map();
  for (const row of balanceSheet?.history ?? []) {
    byPeriodResult.set(row.period, { total_asset: row.total_asset, total_liability: row.total_liability });
  }

  // full_statement gives the finer line items (equity, current assets/
  // liabilities) needed for debt-to-equity/current-ratio/ROE/ROCE -- only
  // present when the caller requested fs=true.
  const fullStatementByParticular = new Map((balanceSheet?.full_statement ?? []).map((p) => [p.particular, byPeriod(p.history)]));
  const equityByPeriod = fullStatementByParticular.get("Equity Capital");
  const currentAssetsByPeriod = fullStatementByParticular.get("Current Assets");
  const currentLiabilitiesByPeriod = fullStatementByParticular.get("Current Liabilities");
  // REVISED 2026-09-16 (correction: never treat liabilities as debt) --
  // `total_debt` is populated ONLY from an explicit borrowings/debt line,
  // searched by an exact allow-list of particular labels -- NEVER from
  // total_liability (trade payables, provisions, and every other
  // non-borrowing liability are not debt). NONE of these labels was present
  // in Reliance's real full_statement (confirmed live, 2026-09-16), so
  // total_debt correctly stays null for that company. Expand this list only
  // after observing an exact label a real account actually returns; never
  // fuzzy-matched against "Liabilities".
  const debtByPeriod = resolveDebtLine(fullStatementByParticular);

  const revenueByPeriod = byPeriod(incomeStatement?.income_statement?.find((c) => c.category === "revenue")?.history);
  const operatingProfitByPeriod = byPeriod(incomeStatement?.income_statement?.find((c) => c.category === "operating_profit")?.history);
  const netProfitByPeriod = byPeriod(incomeStatement?.income_statement?.find((c) => c.category === "net_profit")?.history);
  // Upstox's income-statement full_statement schema does not disclose a
  // dedicated "exceptional items" line for every company -- when the line
  // simply isn't present in full_statement at all, exceptional-item status
  // is undisclosed (null) for every period, never assumed absent (0/false).
  // `exceptionalItemLine` (not a Map) distinguishes "the line doesn't exist"
  // from "the line exists but a specific period's value is missing" -- both
  // resolve to null below, but for two different, correctly-honest reasons.
  const exceptionalItemLine = (incomeStatement?.full_statement ?? []).find((p) => /exceptional/i.test(p.particular));
  const exceptionalItemByPeriod = exceptionalItemLine ? byPeriod(exceptionalItemLine.history) : null;
  // Confirmed present in a real response (Reliance): "EPS - Basic" /
  // "EPS - Diluted" full_statement lines -- feeds the PAT/EPS CAGR
  // requirement directly (an alternative growth measure to plain PAT,
  // useful as a cross-check when share count has changed materially).
  const epsBasicLine = (incomeStatement?.full_statement ?? []).find((p) => p.particular === "EPS - Basic");
  const epsBasicByPeriod = epsBasicLine ? byPeriod(epsBasicLine.history) : null;

  // REVISED 2026-09-16 -- confirmed against a real, live Get Cash Flow
  // response (Reliance Industries, INE002A01018): the endpoint's actual
  // shape is a top-level `cash_flow` array of {category: "operating"|
  // "investing"|"financing", history}, NOT `full_statement`/`history` with
  // a `particular` field the way balance-sheet and income-statement work.
  // This top-level array is the AUTHORITATIVE source for all three category
  // totals -- preserved as such below, never overridden by full_statement.
  const investingByPeriod = byPeriod(cashFlow?.cash_flow?.find((c) => c.category === "investing")?.history);
  const financingByPeriod = byPeriod(cashFlow?.cash_flow?.find((c) => c.category === "financing")?.history);
  const ocfTopLevelByPeriod = byPeriod(cashFlow?.cash_flow?.find((c) => c.category === "operating")?.history);
  // REVISED 2026-09-16 -- confirmed live with `type=consolidated&fs=true`:
  // full_statement DOES populate for this endpoint (see the constant's own
  // comment above). Read ONLY for cross-check/fallback against the
  // authoritative top-level figure above -- never as a replacement source.
  const ocfFullStatementByPeriod = byPeriod(
    (cashFlow?.full_statement ?? []).find((p) => p.particular === CASH_FLOW_FULL_STATEMENT_LABELS.OPERATIONS)?.history
  );

  for (const [period, bs] of byPeriodResult) {
    const totalEquity = equityByPeriod?.get(period) ?? null;
    const totalAsset = bs.total_asset ?? null;
    const totalLiability = bs.total_liability ?? null;
    const ocfTopLevel = ocfTopLevelByPeriod?.get(period) ?? null;
    const ocfFullStatement = ocfFullStatementByPeriod?.get(period) ?? null;
    const ocfResolution = resolveOperatingCashFlow(ocfTopLevel, ocfFullStatement);
    byPeriodResult.set(period, {
      // REVISED 2026-09-16: total_debt is NEVER total_liability (trade
      // payables/provisions/every other non-borrowing liability are not
      // debt) -- populated only from an explicit debt line (resolveDebtLine
      // above), null otherwise. total_liabilities is preserved under its
      // own honest name, used by no debt-scoring sub-metric.
      total_debt: debtByPeriod?.get(period) ?? null,
      total_liabilities: totalLiability,
      total_equity: totalEquity,
      current_assets: currentAssetsByPeriod?.get(period) ?? null,
      current_liabilities: currentLiabilitiesByPeriod?.get(period) ?? null,
      revenue: revenueByPeriod.get(period) ?? null,
      operating_profit: operatingProfitByPeriod.get(period) ?? null,
      net_profit: netProfitByPeriod.get(period) ?? null,
      // REVISED 2026-09-16: no longer approximated as operating_profit --
      // Upstox does not label any field "EBIT" anywhere inspected. Stays
      // null; interest_coverage/roce correctly read NO_DATA via metrics.js's
      // own existing null-handling rather than a silently-approximated ratio.
      ebit: null,
      capital_employed: totalAsset != null && currentLiabilitiesByPeriod?.get(period) != null ? totalAsset - currentLiabilitiesByPeriod.get(period) : null,
      // REVISED 2026-09-16 -- resolved per resolveOperatingCashFlow's rule:
      // top-level authoritative when present (whether or not full_statement
      // agrees); full_statement fallback ONLY when top-level is absent; null
      // (never a guessed pick) when both exist and materially disagree. The
      // raw components and the resolution's own provenance are preserved
      // below so a MANUAL_REVIEW case always carries both figures, never
      // just a silently-dropped null.
      operating_cash_flow: ocfResolution.value,
      operating_cash_flow_provenance: ocfResolution.provenance,
      operating_cash_flow_top_level: ocfTopLevel,
      operating_cash_flow_full_statement: ocfFullStatement,
      // Informational only -- Upstox's "investing"/"financing" categories are
      // the AUTHORITATIVE top-level totals (never overridden by
      // full_statement, which is not parsed for these categories at all --
      // see this file's header comment on CASH_FLOW_FULL_STATEMENT_LABELS).
      // "investing" specifically bundles capex with all other investing
      // activity (treasury investments, acquisitions, etc.) under any label,
      // so it is NEVER interpreted as capital expenditure and free_cash_flow
      // is NEVER derived from it -- no capital_expenditure or
      // free_cash_flow field exists anywhere in this file's output;
      // fcf_consistency's sub-metric correctly stays NO_DATA as a permanent,
      // disclosed limitation (no dedicated capex line exists in this API).
      investing_cash_flow: investingByPeriod?.get(period) ?? null,
      financing_cash_flow: financingByPeriod?.get(period) ?? null,
      eps_basic: epsBasicByPeriod?.get(period) ?? null,
      is_exceptional_item: exceptionalItemByPeriod?.has(period) ? exceptionalItemByPeriod.get(period) !== 0 : null,
      exceptional_item_amount: exceptionalItemByPeriod?.get(period) ?? null,
    });
  }
  return byPeriodResult;
}

/**
 * Maps Upstox's share-holdings response into a per-period promoter-holding
 * series. Pledge is intentionally never populated -- see this file's own
 * header.
 * @returns {Map<string, {promoterHoldingPct: number|null}>}
 */
export function mapShareholdingHistory(shareHoldingsData) {
  const promoters = (shareHoldingsData ?? []).find((c) => c.category === "promoters");
  const result = new Map();
  for (const row of promoters?.history ?? []) result.set(row.period, { promoterHoldingPct: row.value });
  return result;
}

/**
 * Builds one fundamental_source_snapshots-shaped record.
 *
 * REVISED 2026-09-16 (timestamp-basis + audit-status corrections):
 *   - `publication_timestamp` is `null` -- Upstox discloses no filing date
 *     anywhere inspected; never set to `retrievedAtIso` or any other guess.
 *   - `available_from` is the single eligibility timestamp every downstream
 *     point-in-time check actually filters on -- `retrievedAtIso` here,
 *     since that is the only defensible "known available by" moment.
 *   - `timestamp_basis` is `'RETRIEVAL_ONLY'` -- explicit disclosure that
 *     this evidence may reflect restated/latest values and is not
 *     historically point-in-time reliable; only eligible for a screening
 *     cutoff at or after `available_from`, never backfilled into an older
 *     already-published run.
 *   - `audit_status` is `null` (undisclosed) -- Upstox discloses this for no
 *     filing inspected; never defaulted to `"unaudited"` or any other value.
 */
export function buildSnapshotRecord({ instrumentId, exchangeSymbol, isin, periodEnd, periodType, consolidation, rawValues, retrievedAtIso, checksum }) {
  return {
    instrument_id: instrumentId,
    exchange_symbol: exchangeSymbol,
    source: "upstox",
    source_locator: `upstox:fundamentals:${isin}`,
    period_end: periodEnd,
    period_type: periodType,
    consolidation,
    audit_status: null,
    publication_timestamp: null,
    available_from: retrievedAtIso,
    timestamp_basis: "RETRIEVAL_ONLY",
    retrieved_at: retrievedAtIso,
    currency: "INR",
    raw_values: rawValues,
    checksum,
  };
}

/** Upstox period label ("Mar 2025") -> an ISO date for the fiscal period end. */
export function parseUpstoxPeriodLabel(label) {
  const match = /^([A-Za-z]{3,9})\s+(\d{4})$/.exec(label ?? "");
  if (!match) return null;
  const months = { jan: "01", feb: "02", mar: "03", apr: "04", may: "05", jun: "06", jul: "07", aug: "08", sep: "09", oct: "10", nov: "11", dec: "12" };
  const monthKey = match[1].slice(0, 3).toLowerCase();
  const month = months[monthKey];
  if (!month) return null;
  // Upstox period labels are month-end fiscal markers (e.g. "Mar 2025" = 31
  // March 2025) -- day is always the last day of that month.
  const lastDay = new Date(Date.UTC(Number(match[2]), Number(month), 0)).getUTCDate();
  return `${match[2]}-${month}-${String(lastDay).padStart(2, "0")}`;
}

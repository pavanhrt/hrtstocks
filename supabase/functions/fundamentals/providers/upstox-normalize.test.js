import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";
import {
  mapUpstoxSectorToModel, parsePercentOrNumber, buildPeriodFinancials, mapShareholdingHistory,
  buildSnapshotRecord, parseUpstoxPeriodLabel,
} from "./upstox-normalize.js";
import { resolveSectorModel, SECTOR_MODELS } from "../sector-models.js";
import { deriveDebtToEquity, deriveRoe, derivePatCagr, deriveOcfToPat } from "../metrics.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
function fixture(name) {
  return JSON.parse(readFileSync(path.join(__dirname, "__fixtures__", name), "utf-8")).data;
}

// ---------------------------------------------------------------------------
// Sector mapping (bank/NBFC fields, invalid/unrecognized sector)
// ---------------------------------------------------------------------------

test("sector mapping: a recognized bank sector string maps to BANK", () => {
  const profile = fixture("company-profile-bank.json");
  const mapped = mapUpstoxSectorToModel(profile.sector);
  assert.equal(mapped, SECTOR_MODELS.BANK);
  assert.deepEqual(resolveSectorModel(mapped), { sectorModel: SECTOR_MODELS.BANK, resolved: true });
});

test("sector mapping: Refineries is a REVIEWED, verified ordinary industrial sector -- maps to NON_FINANCIAL, not UNSUPPORTED_FALLBACK", () => {
  const profile = fixture("company-profile-unrecognized-sector.json"); // "Refineries" (Reliance's real sector value)
  const mapped = mapUpstoxSectorToModel(profile.sector);
  assert.equal(mapped, SECTOR_MODELS.NON_FINANCIAL);
  assert.deepEqual(resolveSectorModel(mapped), { sectorModel: SECTOR_MODELS.NON_FINANCIAL, resolved: true });
});

test("sector mapping: a genuinely unreviewed sector string resolves to UNSUPPORTED_FALLBACK, never guessed as NON_FINANCIAL", () => {
  const mapped = mapUpstoxSectorToModel("Some Brand New Sector Never Observed");
  assert.equal(mapped, "Some Brand New Sector Never Observed"); // passed through unchanged, not silently defaulted
  assert.deepEqual(resolveSectorModel(mapped), { sectorModel: SECTOR_MODELS.UNSUPPORTED_FALLBACK, resolved: true });
});

test("sector mapping: insurance is a REVIEWED but deliberately unsupported regulated sector -- resolves to UNSUPPORTED_FALLBACK (-> MANUAL_REVIEW at the score level), never silently scored under a model built for a different business", () => {
  for (const insuranceSector of ["Insurance", "Life Insurance", "General Insurance"]) {
    const mapped = mapUpstoxSectorToModel(insuranceSector);
    assert.equal(mapped, SECTOR_MODELS.UNSUPPORTED_FALLBACK);
  }
});

test("sector mapping: an undisclosed sector (null/empty) is NO_DATA, not UNSUPPORTED_FALLBACK", () => {
  assert.equal(mapUpstoxSectorToModel(null), null);
  assert.equal(mapUpstoxSectorToModel(""), null);
  assert.deepEqual(resolveSectorModel(mapUpstoxSectorToModel(null)), { sectorModel: null, resolved: false });
});

// ---------------------------------------------------------------------------
// Key ratios (ROE/ROCE/ROA percentage parsing)
// ---------------------------------------------------------------------------

test("parsePercentOrNumber: strips a trailing percent sign", () => {
  const ratios = fixture("key-ratios.json");
  const roe = ratios.find((r) => r.name === "ROE");
  assert.equal(parsePercentOrNumber(roe.company_value), 8.94);
});

test("parsePercentOrNumber: a plain numeric string (no percent) parses too", () => {
  const ratios = fixture("key-ratios.json");
  const pe = ratios.find((r) => r.name === "P/E");
  assert.equal(parsePercentOrNumber(pe.company_value), 20.15);
});

test("parsePercentOrNumber: null/unparseable input returns null, never zero", () => {
  assert.equal(parsePercentOrNumber(null), null);
  assert.equal(parsePercentOrNumber("n/a"), null);
});

// ---------------------------------------------------------------------------
// Balance sheet + income statement + cash flow -> per-period financials
// (consolidated/standalone, annual/quarterly, debt/equity/cash/EBITDA,
// revenue/operating-profit/PAT/exceptional items, missing line items,
// negative values, unit conversion)
// ---------------------------------------------------------------------------

test("buildPeriodFinancials: consolidated annual statement maps revenue/operating_profit/net_profit/equity correctly, values stay in Crore (no unit conversion)", () => {
  const balanceSheet = fixture("balance-sheet-consolidated.json");
  const cashFlow = fixture("cash-flow.json");
  // income-statement-quarterly.json is quarterly; for this annual test we
  // reuse balance-sheet's own periods against a synthetic annual income
  // statement matching the same period labels.
  const incomeStatement = { income_statement: [
    { category: "revenue", history: [{ value: 982671, period: "Mar 2025" }] },
    { category: "operating_profit", history: [{ value: 106017, period: "Mar 2025" }] },
    { category: "net_profit", history: [{ value: 80787, period: "Mar 2025" }] },
  ], full_statement: [] };

  const byPeriod = buildPeriodFinancials({ balanceSheet, incomeStatement, cashFlow });
  const mar2025 = byPeriod.get("Mar 2025");
  assert.equal(mar2025.revenue, 982671); // unchanged Crore figure, not converted to absolute rupees
  assert.equal(mar2025.operating_profit, 106017);
  assert.equal(mar2025.net_profit, 80787);
  assert.equal(mar2025.total_equity, 1009626);
  assert.equal(mar2025.current_assets, 499270);
  assert.equal(mar2025.current_liabilities, 453737);
  // REVISED 2026-09-16: total_liability is NEVER treated as debt. This
  // fixture (Reliance's real balance sheet) has no explicit
  // Borrowings/Total Debt line, so total_debt is correctly null while
  // total_liabilities preserves the real (non-debt) figure under its own name.
  assert.equal(mar2025.total_debt, null);
  assert.equal(mar2025.total_liabilities, 940495);
  // EBIT is no longer approximated as operating_profit -- Upstox discloses
  // no field labeled EBIT anywhere inspected.
  assert.equal(mar2025.ebit, null);
  // Verified against a real live Get Cash Flow response (Reliance
  // Industries, 2026-09-16) -- the endpoint's actual shape is a top-level
  // `cash_flow` array of {category, history}, not `full_statement`/
  // `history` with a `particular` field.
  assert.equal(mar2025.operating_cash_flow, 178703);
  assert.equal(mar2025.investing_cash_flow, -137535);
});

test("buildPeriodFinancials: real Upstox cash-flow shape (category-based, not particular-based) is parsed correctly -- confirmed live 2026-09-16", () => {
  const cashFlow = fixture("cash-flow.json");
  const byPeriod = buildPeriodFinancials({ balanceSheet: { history: [{ period: "Mar 2026" }, { period: "Mar 2025" }] }, incomeStatement: {}, cashFlow });
  assert.equal(byPeriod.get("Mar 2026").operating_cash_flow, 192113);
  assert.equal(byPeriod.get("Mar 2026").investing_cash_flow, -101089);
});

// ---------------------------------------------------------------------------
// Cash flow full_statement cross-check (verified live 2026-09-16 with
// type=consolidated&fs=true): top-level cash_flow category array is
// authoritative; full_statement's exact "Cash flow from Operations" label is
// a cross-check/fallback only; material disagreement is MANUAL_REVIEW, never
// a silently-picked value; investing is never capex/FCF.
// ---------------------------------------------------------------------------

test("cash flow: top-level category parsing -- operating/investing/financing totals all come from the authoritative top-level array", () => {
  const cashFlow = fixture("cash-flow.json");
  const byPeriod = buildPeriodFinancials({ balanceSheet: { history: [{ period: "Mar 2026" }, { period: "Mar 2025" }] }, incomeStatement: {}, cashFlow });
  const mar2026 = byPeriod.get("Mar 2026");
  assert.equal(mar2026.operating_cash_flow, 192113);
  assert.equal(mar2026.investing_cash_flow, -101089);
  assert.equal(mar2026.financing_cash_flow, -51549);
  assert.equal(mar2026.operating_cash_flow_provenance, "TOP_LEVEL");
});

test("cash flow: full-statement parsing -- 'Cash flow from Operations' is read from the exact reviewed label, never a fuzzy match", () => {
  const cashFlow = fixture("cash-flow.json");
  const byPeriod = buildPeriodFinancials({ balanceSheet: { history: [{ period: "Mar 2025" }] }, incomeStatement: {}, cashFlow });
  const period = byPeriod.get("Mar 2025");
  assert.equal(period.operating_cash_flow_top_level, 178703);
  assert.equal(period.operating_cash_flow_full_statement, 178703);
});

test("cash flow: top-level and full-statement agreement resolves to the top-level value with provenance TOP_LEVEL", () => {
  const cashFlow = fixture("cash-flow.json"); // fixture's full_statement operations line matches top-level exactly
  const byPeriod = buildPeriodFinancials({ balanceSheet: { history: [{ period: "Mar 2026" }] }, incomeStatement: {}, cashFlow });
  const period = byPeriod.get("Mar 2026");
  assert.equal(period.operating_cash_flow, 192113);
  assert.equal(period.operating_cash_flow_provenance, "TOP_LEVEL");
});

test("cash flow: missing top-level value falls back to a valid full-statement value, provenance FULL_STATEMENT_FALLBACK", () => {
  const cashFlow = {
    cash_flow: [{ category: "investing", history: [{ value: -500, period: "Mar 2025" }] }], // no "operating" category at all
    full_statement: [{ particular: "Cash flow from Operations", history: [{ value: 4200, period: "Mar 2025" }] }],
  };
  const byPeriod = buildPeriodFinancials({ balanceSheet: { history: [{ period: "Mar 2025" }] }, incomeStatement: {}, cashFlow });
  const period = byPeriod.get("Mar 2025");
  assert.equal(period.operating_cash_flow, 4200);
  assert.equal(period.operating_cash_flow_provenance, "FULL_STATEMENT_FALLBACK");
  assert.equal(period.operating_cash_flow_top_level, null);
  assert.equal(period.operating_cash_flow_full_statement, 4200);
});

test("cash flow: material disagreement between top-level and full-statement produces null (MANUAL_REVIEW at the metrics layer), never a silently-picked value -- both raw figures are preserved", () => {
  const cashFlow = {
    cash_flow: [{ category: "operating", history: [{ value: 178703, period: "Mar 2025" }] }],
    full_statement: [{ particular: "Cash flow from Operations", history: [{ value: 90000, period: "Mar 2025" }] }], // >1% off -- a real conflict, not rounding
  };
  const byPeriod = buildPeriodFinancials({ balanceSheet: { history: [{ period: "Mar 2025" }] }, incomeStatement: {}, cashFlow });
  const period = byPeriod.get("Mar 2025");
  assert.equal(period.operating_cash_flow, null);
  assert.equal(period.operating_cash_flow_provenance, "DISAGREEMENT");
  assert.equal(period.operating_cash_flow_top_level, 178703);
  assert.equal(period.operating_cash_flow_full_statement, 90000);
  // Fed into metrics.js, this must surface as MANUAL_REVIEW, never NO_DATA
  // (an absence of evidence) and never a fabricated ratio off either figure.
  const result = deriveOcfToPat(period.operating_cash_flow, 80787, {
    provenance: period.operating_cash_flow_provenance,
    topLevel: period.operating_cash_flow_top_level,
    fullStatement: period.operating_cash_flow_full_statement,
  });
  assert.equal(result.status, "MANUAL_REVIEW");
});

test("cash flow: a small rounding difference (within 1% tolerance) is NOT treated as a material disagreement", () => {
  const cashFlow = {
    cash_flow: [{ category: "operating", history: [{ value: 178703, period: "Mar 2025" }] }],
    full_statement: [{ particular: "Cash flow from Operations", history: [{ value: 178700, period: "Mar 2025" }] }], // 3 Crore off, well under 1%
  };
  const byPeriod = buildPeriodFinancials({ balanceSheet: { history: [{ period: "Mar 2025" }] }, incomeStatement: {}, cashFlow });
  const period = byPeriod.get("Mar 2025");
  assert.equal(period.operating_cash_flow, 178703); // top-level remains authoritative
  assert.equal(period.operating_cash_flow_provenance, "TOP_LEVEL");
});

test("cash flow: investing cash flow is NEVER interpreted as capex, and free cash flow is NEVER derived -- no dedicated capex line exists in this API", () => {
  const cashFlow = fixture("cash-flow.json");
  const byPeriod = buildPeriodFinancials({ balanceSheet: { history: [{ period: "Mar 2026" }] }, incomeStatement: {}, cashFlow });
  const period = byPeriod.get("Mar 2026");
  assert.equal(period.investing_cash_flow, -101089); // preserved as its own disclosed category, unchanged
  for (const field of ["capital_expenditure", "capex", "free_cash_flow", "fcf"]) {
    assert.ok(!(field in period), `financials object must never contain a derived "${field}" field`);
  }
});

test("cash flow: no debt/EBIT/EBITDA/interest-coverage/net-debt inference is ever made from a cash-flow response", () => {
  const cashFlow = fixture("cash-flow.json");
  const byPeriod = buildPeriodFinancials({ balanceSheet: { history: [{ period: "Mar 2026" }] }, incomeStatement: {}, cashFlow });
  const period = byPeriod.get("Mar 2026");
  assert.equal(period.total_debt, null); // no balance-sheet borrowings line was supplied in this test -- correctly NO_DATA
  assert.equal(period.ebit, null);
  for (const field of ["ebitda", "interest_expense", "interest_coverage", "net_debt", "net_debt_to_ebitda"]) {
    assert.ok(!(field in period), `financials object must never contain a derived "${field}" field from a cash-flow response`);
  }
});

test("buildPeriodFinancials: EPS (Basic) is extracted from full_statement when present -- an alternative PAT/EPS growth measure", () => {
  const incomeStatement = {
    income_statement: [],
    full_statement: [{ particular: "EPS - Basic", history: [{ period: "Mar 2026", value: 59.69 }, { period: "Mar 2025", value: 51.47 }] }],
  };
  const byPeriod = buildPeriodFinancials({ balanceSheet: { history: [{ period: "Mar 2026" }, { period: "Mar 2025" }] }, incomeStatement, cashFlow: {} });
  assert.equal(byPeriod.get("Mar 2026").eps_basic, 59.69);
  assert.equal(byPeriod.get("Mar 2025").eps_basic, 51.47);
});

test("buildPeriodFinancials: negative equity is preserved as a real negative number, never clamped or silently zeroed", () => {
  const balanceSheet = fixture("balance-sheet-standalone-negative-equity.json");
  const byPeriod = buildPeriodFinancials({ balanceSheet, incomeStatement: {}, cashFlow: {} });
  const period = byPeriod.get("Mar 2025");
  assert.equal(period.total_equity, -120);
  // Feeding this straight into metrics.js's deriver confirms the whole
  // pipeline (adapter -> metrics) correctly reports NOT_APPLICABLE, never a
  // fabricated debt-to-equity ratio against negative equity.
  const result = deriveDebtToEquity({ total_debt: period.total_debt, total_equity: period.total_equity });
  assert.equal(result.status, "NOT_APPLICABLE");
});

test("buildPeriodFinancials: total_liability is NEVER treated as debt -- trade payables/provisions/every other non-borrowing liability cannot enter debt-to-equity scoring", () => {
  const balanceSheet = {
    history: [{ total_asset: 1000, total_liability: 600, period: "Mar 2025" }],
    full_statement: [{ particular: "Equity Capital", history: [{ period: "Mar 2025", value: 400 }] }],
    // No Borrowings/Total Debt/Long or Short Term Borrowings line at all --
    // total_liability (600) must NOT leak into total_debt.
  };
  const byPeriod = buildPeriodFinancials({ balanceSheet, incomeStatement: {}, cashFlow: {} });
  const period = byPeriod.get("Mar 2025");
  assert.equal(period.total_debt, null);
  assert.equal(period.total_liabilities, 600);
  // End-to-end: feeding this into deriveDebtToEquity must read NO_DATA, not
  // a fabricated ratio computed from total_liability.
  const result = deriveDebtToEquity({ total_debt: period.total_debt, total_equity: period.total_equity });
  assert.equal(result.status, "NO_DATA");
});

test("buildPeriodFinancials: an explicit combined debt line (e.g. 'Borrowings') IS used for total_debt when present", () => {
  const balanceSheet = {
    history: [{ total_asset: 1000, total_liability: 600, period: "Mar 2025" }],
    full_statement: [
      { particular: "Equity Capital", history: [{ period: "Mar 2025", value: 400 }] },
      { particular: "Borrowings", history: [{ period: "Mar 2025", value: 250 }] },
    ],
  };
  const byPeriod = buildPeriodFinancials({ balanceSheet, incomeStatement: {}, cashFlow: {} });
  const period = byPeriod.get("Mar 2025");
  assert.equal(period.total_debt, 250); // the explicit borrowings figure, not total_liability (600)
  assert.equal(period.total_liabilities, 600);
});

test("buildPeriodFinancials: Long Term + Short Term Borrowings are summed ONLY when BOTH are present -- never half a breakdown treated as the whole", () => {
  const bothPresent = {
    history: [{ total_asset: 1000, total_liability: 600, period: "Mar 2025" }],
    full_statement: [
      { particular: "Long Term Borrowings", history: [{ period: "Mar 2025", value: 150 }] },
      { particular: "Short Term Borrowings", history: [{ period: "Mar 2025", value: 50 }] },
    ],
  };
  assert.equal(buildPeriodFinancials({ balanceSheet: bothPresent, incomeStatement: {}, cashFlow: {} }).get("Mar 2025").total_debt, 200);

  const onlyLongTerm = {
    history: [{ total_asset: 1000, total_liability: 600, period: "Mar 2025" }],
    full_statement: [{ particular: "Long Term Borrowings", history: [{ period: "Mar 2025", value: 150 }] }],
  };
  assert.equal(
    buildPeriodFinancials({ balanceSheet: onlyLongTerm, incomeStatement: {}, cashFlow: {} }).get("Mar 2025").total_debt,
    null,
    "only long-term disclosed, short-term missing -- must not understate by treating half the breakdown as the whole debt figure"
  );
});

test("buildPeriodFinancials: quarterly periods map correctly and exceptional items are distinguished from ordinary PAT growth", () => {
  const incomeStatement = fixture("income-statement-quarterly.json");
  const byPeriod = buildPeriodFinancials({ balanceSheet: { history: [{ period: "Jun 2026" }, { period: "Mar 2026" }] }, incomeStatement, cashFlow: {} });
  const jun2026 = byPeriod.get("Jun 2026");
  assert.equal(jun2026.net_profit, 23902);
  assert.equal(jun2026.is_exceptional_item, true); // Exceptional Items = 3200, non-zero
  const mar2026 = byPeriod.get("Mar 2026");
  assert.equal(mar2026.is_exceptional_item, false); // Exceptional Items = 0 for this period
});

test("buildPeriodFinancials: missing line items (no full_statement at all) leave equity/current-assets fields undefined, never zero", () => {
  const incomeStatement = fixture("income-statement-loss-making.json");
  const byPeriod = buildPeriodFinancials({ balanceSheet: { history: [{ period: "Mar 2025" }] }, incomeStatement, cashFlow: {} });
  const period = byPeriod.get("Mar 2025");
  assert.equal(period.total_equity, null);
  assert.equal(period.is_exceptional_item, null); // undisclosed, not "false"
  assert.equal(period.net_profit, -420); // loss-making, real negative value preserved
});

test("buildPeriodFinancials + metrics.js: a loss-making company's PAT CAGR reports NO_DATA end to end (technical-input independence: no technical field anywhere in this pipeline)", () => {
  const incomeStatement = fixture("income-statement-loss-making.json");
  const byPeriod = buildPeriodFinancials({ balanceSheet: { history: [{ period: "Mar 2025" }, { period: "Mar 2024" }] }, incomeStatement, cashFlow: {} });
  const current = byPeriod.get("Mar 2025").net_profit;
  const base = byPeriod.get("Mar 2024").net_profit;
  const result = derivePatCagr(1, current, base);
  assert.equal(result.status, "NO_DATA");
  // Confirm the financials object itself never contains a technical field.
  const period = byPeriod.get("Mar 2025");
  for (const technicalField of ["rsi", "macd", "ema", "dowState", "gateResult", "candlestickPattern"]) {
    assert.ok(!(technicalField in period), `financials object must never contain "${technicalField}"`);
  }
});

// ---------------------------------------------------------------------------
// Shareholding history (promoter percentages; pledge deliberately absent)
// ---------------------------------------------------------------------------

test("mapShareholdingHistory: maps promoter holding percentages by period", () => {
  const shareHoldings = fixture("share-holdings.json");
  const byPeriod = mapShareholdingHistory(shareHoldings);
  assert.equal(byPeriod.get("Mar 2026").promoterHoldingPct, 50.0);
  assert.equal(byPeriod.get("Jun 2025").promoterHoldingPct, 50.07);
});

test("mapShareholdingHistory: never produces a pledge figure -- Upstox discloses no pledge/encumbrance data at all", () => {
  const shareHoldings = fixture("share-holdings.json");
  const byPeriod = mapShareholdingHistory(shareHoldings);
  for (const value of byPeriod.values()) {
    assert.ok(!("pledgedPct" in value) && !("pledge" in value), "promoter_pledge must remain NO_DATA -- never derived from Upstox share-holdings");
  }
});

// ---------------------------------------------------------------------------
// Point-in-time: responses without publication timestamps
// ---------------------------------------------------------------------------

test("buildSnapshotRecord: publication_timestamp is null, available_from equals retrieved_at, timestamp_basis is RETRIEVAL_ONLY -- never a fabricated filing date", () => {
  const record = buildSnapshotRecord({
    instrumentId: "NSE_TEST", exchangeSymbol: "TEST", isin: "INE002A01018", periodEnd: "2025-03-31",
    periodType: "annual", consolidation: "consolidated", rawValues: { revenue: 100 },
    retrievedAtIso: "2026-09-16T10:00:00Z", checksum: "sha256:abc",
  });
  assert.equal(record.publication_timestamp, null);
  assert.equal(record.available_from, "2026-09-16T10:00:00Z");
  assert.equal(record.retrieved_at, "2026-09-16T10:00:00Z");
  assert.equal(record.timestamp_basis, "RETRIEVAL_ONLY");
  assert.equal(record.source, "upstox");
});

test("buildSnapshotRecord: audit_status is null (undisclosed), never defaulted to audited/limited_review/unaudited", () => {
  const record = buildSnapshotRecord({
    instrumentId: "NSE_TEST", exchangeSymbol: "TEST", isin: "INE002A01018", periodEnd: "2025-03-31",
    periodType: "annual", consolidation: "consolidated", rawValues: { revenue: 100 },
    retrievedAtIso: "2026-09-16T10:00:00Z", checksum: "sha256:abc",
  });
  assert.equal(record.audit_status, null);
  assert.notEqual(record.audit_status, "unaudited");
  assert.notEqual(record.audit_status, "audited");
  assert.notEqual(record.audit_status, "limited_review");
});

test("buildSnapshotRecord: passes validateSnapshot() end to end -- proves the adapter's output actually satisfies the import-validation contract", async () => {
  const { validateSnapshot } = await import("../normalize.js");
  const record = buildSnapshotRecord({
    instrumentId: "NSE_TEST", exchangeSymbol: "TEST", isin: "INE002A01018", periodEnd: "2025-03-31",
    periodType: "annual", consolidation: "consolidated", rawValues: { revenue: 100 },
    retrievedAtIso: "2026-09-16T10:00:00Z", checksum: "sha256:abc",
  });
  assert.deepEqual(validateSnapshot(record), { valid: true, errors: [] });
});

test("parseUpstoxPeriodLabel: converts a fiscal period label into its ISO month-end date", () => {
  assert.equal(parseUpstoxPeriodLabel("Mar 2025"), "2025-03-31");
  assert.equal(parseUpstoxPeriodLabel("Jun 2026"), "2026-06-30");
  assert.equal(parseUpstoxPeriodLabel("Dec 2025"), "2025-12-31");
});

test("parseUpstoxPeriodLabel: never guesses on an unrecognized label", () => {
  assert.equal(parseUpstoxPeriodLabel("not a period"), null);
  assert.equal(parseUpstoxPeriodLabel(""), null);
  assert.equal(parseUpstoxPeriodLabel(undefined), null);
});

// ---------------------------------------------------------------------------
// ROE via metrics.js fed from parsed key-ratios (bank/NBFC + non-financial
// share the same deriveRoe -- only the sector-model routing differs)
// ---------------------------------------------------------------------------

test("end to end: a parsed key-ratios ROE feeds correctly into deriveRoe-shaped scoring input (as a direct ratio, no re-derivation needed for the ratio itself)", () => {
  const ratios = fixture("key-ratios.json");
  const roePercent = parsePercentOrNumber(ratios.find((r) => r.name === "ROE").company_value);
  assert.equal(roePercent, 8.94);
  // fundamental-score.yaml's roe thresholds are expressed as a fraction
  // (0.0894), not a percentage (8.94) -- the ingestion layer must divide by
  // 100 before calling deriveRoe/scoreSubMetric. Documented here as a
  // required conversion step, verified against a real observed value.
  const roeFraction = roePercent / 100;
  const result = deriveRoe({ net_profit: roeFraction * 1000, average_shareholder_equity: 1000 });
  assert.equal(result.status, "OK");
  assert.ok(Math.abs(result.value - roeFraction) < 1e-9);
});

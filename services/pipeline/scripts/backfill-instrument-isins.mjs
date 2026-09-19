// Backfills instruments.isin from Upstox's own PUBLIC NSE instrument master
// file (https://assets.upstox.com/market-quote/instruments/exchange/NSE.json.gz,
// documented at https://upstox.com/developer/api-documentation/instruments/,
// verified live 2026-09-16). This file needs no authentication -- it is a
// static, publicly downloadable asset -- so this script needs NO Upstox
// access token, only database access to read/write `instruments`.
//
// WHY THIS EXISTS: every Upstox Fundamentals endpoint is keyed by ISIN, but
// this project's `instruments` table was originally populated from an NSE
// constituent list that never captured ISIN -- confirmed live 2026-09-16
// (all 505 rows, including all 501 non-index stocks, had isin = null).
// Without this backfill, collect-upstox-sectors.mjs and any future
// fundamentals ingestion have zero eligible instruments to work with.
//
// MATCHING RULE (never invents an ISIN -- AGENTS.md: "never invent,
// interpolate, or silently repair market data"):
//   1. Only NSE_EQ-segment records from the master file are considered.
//   2. Matched by exact `trading_symbol` == `instruments.symbol`.
//   3. When a trading_symbol maps to more than one distinct ISIN in the
//      master (observed for a handful of symbols, e.g. CHOLAFIN, MOTHERSON),
//      candidates whose `instrument_type` is a known non-equity code
//      (NON_EQUITY_INSTRUMENT_TYPES below -- debt/warrant/government-security
//      series NSE lists under the same trading symbol as the real equity
//      share) are excluded first. If exactly one candidate remains, it is
//      used (this is reading an authoritative field the same source file
//      already provides, not guessing). If more than one non-excluded
//      candidate remains, the symbol is reported as AMBIGUOUS and never
//      auto-resolved.
//   4. A symbol with zero matches in the master (observed for DUMMYHEG, a
//      stale placeholder-looking entry not present under any segment of the
//      live master) is reported as UNMATCHED, never guessed from a similar
//      symbol.
//   5. Only NULL isin values are ever written -- an instrument that already
//      has a non-null isin is never touched, so a conflicting future value
//      in the master can never silently overwrite a value this project
//      already trusts; that would need its own explicit review.
//
// SAFE BY DEFAULT: dry-run unless --apply is passed. Dry-run prints the plan
// (matched/unmatched/ambiguous counts and lists) and writes a JSON report;
// nothing is written to the database. Idempotent: re-running after a
// successful --apply updates zero further rows (every previously-null isin
// is now set), so it is always safe to re-run later as new instruments are
// added to the universe.
//
// Usage:
//   DATABASE_URL=postgres://... node services/pipeline/scripts/backfill-instrument-isins.mjs [--apply] [--out FILE]

import { openDb } from "../src/db/client.js";
import * as ops from "../src/db/ops.js";
import zlib from "node:zlib";
import fs from "node:fs/promises";

const MASTER_URL = "https://assets.upstox.com/market-quote/instruments/exchange/NSE.json.gz";
const NON_EQUITY_INSTRUMENT_TYPES = new Set(["D1", "D2", "W1", "N1", "N2", "N3", "N4"]);

function parseArgs(argv) {
  const args = { apply: false, out: "isin-backfill-report.json" };
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === "--apply") args.apply = true;
    else if (argv[i] === "--out") args.out = argv[++i];
  }
  return args;
}

/** @returns {Map<string, {isin: string, instrumentType: string}[]>} trading_symbol -> every NSE_EQ-segment candidate observed for it */
async function fetchEquityCandidatesBySymbol() {
  const res = await fetch(MASTER_URL);
  if (!res.ok) throw new Error(`failed to fetch Upstox instrument master: HTTP ${res.status}`);
  const gz = Buffer.from(await res.arrayBuffer());
  const json = zlib.gunzipSync(gz).toString("utf-8");
  const records = JSON.parse(json);
  const bySymbol = new Map();
  for (const rec of records) {
    if (rec.segment !== "NSE_EQ") continue;
    if (!bySymbol.has(rec.trading_symbol)) bySymbol.set(rec.trading_symbol, []);
    bySymbol.get(rec.trading_symbol).push({ isin: rec.isin, instrumentType: rec.instrument_type });
  }
  return bySymbol;
}

/** @returns {{status: "matched", isin: string, resolvedFromAmbiguous: boolean} | {status: "unmatched"} | {status: "ambiguous", candidates: object[]}} */
function resolveIsin(symbol, bySymbol) {
  const candidates = bySymbol.get(symbol);
  if (!candidates) return { status: "unmatched" };
  const distinctIsins = new Set(candidates.map((c) => c.isin));
  if (distinctIsins.size === 1) return { status: "matched", isin: candidates[0].isin, resolvedFromAmbiguous: false };
  const equityLike = candidates.filter((c) => !NON_EQUITY_INSTRUMENT_TYPES.has(c.instrumentType));
  const distinctEquityIsins = new Set(equityLike.map((c) => c.isin));
  if (distinctEquityIsins.size === 1) return { status: "matched", isin: equityLike[0].isin, resolvedFromAmbiguous: true };
  return { status: "ambiguous", candidates };
}

async function main() {
  const { apply, out } = parseArgs(process.argv.slice(2));
  const db = await openDb(); // DATABASE_URL (local) or CLOUD_SQL_INSTANCE + DB_USER (IAM)

  console.log("Fetching Upstox's public NSE instrument master (no auth required)...");
  const bySymbol = await fetchEquityCandidatesBySymbol();
  console.log(`Loaded ${bySymbol.size} distinct NSE_EQ trading symbols.`);

  const { data: instruments, error } = await ops.select(db, `select id, symbol, isin from instruments
        where is_index = $1`, [false], "many");
  if (error) throw error;

  const toUpdate = [];
  const unmatched = [];
  const ambiguous = [];
  const alreadyPopulated = [];

  for (const row of instruments) {
    if (row.isin != null) {
      alreadyPopulated.push(row.symbol);
      continue;
    }
    const resolution = resolveIsin(row.symbol, bySymbol);
    if (resolution.status === "matched") toUpdate.push({ id: row.id, symbol: row.symbol, isin: resolution.isin, resolvedFromAmbiguous: resolution.resolvedFromAmbiguous });
    else if (resolution.status === "unmatched") unmatched.push(row.symbol);
    else ambiguous.push({ symbol: row.symbol, candidates: resolution.candidates });
  }

  const report = {
    generatedAt: new Date().toISOString(),
    totalInstruments: instruments.length,
    alreadyPopulated: alreadyPopulated.length,
    toUpdate: toUpdate.length,
    resolvedFromBenignAmbiguity: toUpdate.filter((r) => r.resolvedFromAmbiguous).length,
    unmatched,
    ambiguous,
    applied: apply,
  };
  await fs.writeFile(out, JSON.stringify(report, null, 2));

  console.log(`\n${toUpdate.length} instrument(s) matched and ready to update, ${alreadyPopulated.length} already had an isin, ${unmatched.length} unmatched, ${ambiguous.length} still ambiguous.`);
  if (unmatched.length > 0) console.log(`UNMATCHED (no equity candidate in the current Upstox master -- never guessed): ${unmatched.join(", ")}`);
  if (ambiguous.length > 0) console.log(`AMBIGUOUS (multiple equity-like candidates -- never auto-resolved): ${ambiguous.map((a) => a.symbol).join(", ")}`);

  if (!apply) {
    console.log(`\nDRY RUN -- nothing was written. Re-run with --apply to write ${toUpdate.length} isin value(s). Full report: ${out}`);
    return;
  }

  console.log(`\nApplying ${toUpdate.length} update(s)...`);
  let applied = 0;
  for (const row of toUpdate) {
    const { error: updateError } = await ops.update(db, "instruments", { isin: row.isin }, { id: row.id, isin: null });
    if (updateError) throw updateError;
    applied++;
  }
  console.log(`Done. Applied ${applied} update(s). Full report: ${out}`);
}

main().then(() => process.exit(0)).catch((err) => {
  console.error("backfill-instrument-isins failed:", err.message);
  process.exit(1);
});

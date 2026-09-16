// Correction 8 (fundamental-score correction pass, 2026-09-16): collects the
// DISTINCT Upstox `profile.sector` strings actually present across the live
// 501-stock universe, so upstox-sector-taxonomy.js can be extended with a
// reviewed, explicit, versioned mapping for each one -- instead of guessing
// sector names in advance (which is how "Refineries" -- Reliance's real
// sector -- ended up unmapped and falling to UNSUPPORTED_FALLBACK).
//
// READ-ONLY: issues only GET requests to the Upstox Fundamentals API
// (profile endpoint) and only SELECTs from the `instruments` table. Writes
// nothing to the database and nothing back to Upstox. Safe to re-run.
//
// The access token is read from the environment and used only to build the
// Authorization header inside upstox-client.js -- this script never logs,
// prints, or writes UPSTOX_ACCESS_TOKEN (or SUPABASE_SERVICE_ROLE_KEY) to
// the console or to the output file, and never includes it in an error
// message. If a request fails, only the ISIN, endpoint, and HTTP status are
// reported.
//
// Usage:
//   SUPABASE_URL=... SUPABASE_SERVICE_ROLE_KEY=... UPSTOX_ACCESS_TOKEN=... \
//     node supabase/scripts/collect-upstox-sectors.mjs [--out FILE] [--delay-ms N]
//
// --out FILE       write the JSON summary here (default: sector-report.json
//                   in the current directory)
// --delay-ms N     fixed delay between requests, default 150ms (~6-7
//                   req/sec) -- deliberately far below Upstox's documented
//                   50/sec, 500/min, 2000/30min limits (see rate-limiter.js)
//                   since this is a one-off diagnostic script, not the
//                   production ingestion batcher.

import { createClient } from "@supabase/supabase-js";
import { createUpstoxClient, UpstoxApiError } from "../functions/fundamentals/providers/upstox-client.js";
import { classifyUpstoxSector, UPSTOX_SECTOR_TAXONOMY_VERSION } from "../functions/fundamentals/providers/upstox-sector-taxonomy.js";

const SUPABASE_URL = process.env.SUPABASE_URL;
const SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;
const ACCESS_TOKEN = process.env.UPSTOX_ACCESS_TOKEN;

if (!SUPABASE_URL || !SERVICE_ROLE_KEY) {
  console.error("SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY must be set in the environment.");
  process.exit(1);
}
if (!ACCESS_TOKEN) {
  console.error("UPSTOX_ACCESS_TOKEN must be set in the environment (not printed by this script under any circumstance).");
  process.exit(1);
}

function parseArgs(argv) {
  const args = { out: "sector-report.json", delayMs: 150 };
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === "--out") args.out = argv[++i];
    else if (argv[i] === "--delay-ms") args.delayMs = Number(argv[++i]);
  }
  return args;
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

async function main() {
  const { out, delayMs } = parseArgs(process.argv.slice(2));

  const supabase = createClient(SUPABASE_URL, SERVICE_ROLE_KEY, { auth: { persistSession: false } });
  const upstox = createUpstoxClient(ACCESS_TOKEN);

  const { data: instruments, error } = await supabase
    .from("instruments")
    .select("id, symbol, isin")
    .eq("is_index", false)
    .not("isin", "is", null)
    .order("symbol", { ascending: true });
  if (error) throw error;

  console.log(`Collecting Upstox profile.sector for ${instruments.length} instruments (delay ${delayMs}ms/request)...`);

  /** @type {Map<string, {count: number, exampleSymbol: string, exampleIsin: string}>} */
  const sectorCounts = new Map();
  const failures = [];

  for (const [index, instrument] of instruments.entries()) {
    try {
      const profile = await upstox.getProfile(instrument.isin);
      const sector = profile?.sector ?? null;
      const key = sector === null ? "(null -- not disclosed)" : sector;
      if (!sectorCounts.has(key)) {
        sectorCounts.set(key, { count: 0, exampleSymbol: instrument.symbol, exampleIsin: instrument.isin });
      }
      sectorCounts.get(key).count += 1;
    } catch (err) {
      if (err instanceof UpstoxApiError) {
        failures.push({ symbol: instrument.symbol, isin: instrument.isin, status: err.status, retryable: err.retryable });
      } else {
        failures.push({ symbol: instrument.symbol, isin: instrument.isin, status: null, message: "unexpected non-Upstox error" });
      }
    }
    if ((index + 1) % 25 === 0) console.log(`  ...${index + 1}/${instruments.length}`);
    await sleep(delayMs);
  }

  const rows = [...sectorCounts.entries()]
    .map(([sector, info]) => {
      const classification = sector.startsWith("(null") ? null : classifyUpstoxSector(sector);
      return {
        sector,
        count: info.count,
        exampleSymbol: info.exampleSymbol,
        exampleIsin: info.exampleIsin,
        mappedModel: classification?.model ?? (sector.startsWith("(null") ? null : "UNSUPPORTED_FALLBACK (not yet in taxonomy)"),
      };
    })
    .sort((a, b) => b.count - a.count);

  const unmapped = rows.filter((r) => r.mappedModel === "UNSUPPORTED_FALLBACK (not yet in taxonomy)");

  const report = {
    generatedAt: new Date().toISOString(),
    taxonomyVersionCheckedAgainst: UPSTOX_SECTOR_TAXONOMY_VERSION,
    totalInstruments: instruments.length,
    totalFailures: failures.length,
    distinctSectors: rows.length,
    sectors: rows,
    unmappedSectorsNeedingReview: unmapped.map((r) => r.sector),
    failures,
  };

  const fs = await import("node:fs/promises");
  await fs.writeFile(out, JSON.stringify(report, null, 2));

  console.log(`\nDone. ${rows.length} distinct sector strings across ${instruments.length - failures.length} successfully-fetched instruments (${failures.length} failures).`);
  if (unmapped.length > 0) {
    console.log(`\n${unmapped.length} sector string(s) are NOT YET in upstox-sector-taxonomy.js and currently resolve to UNSUPPORTED_FALLBACK (MANUAL_REVIEW terminal status, never a fabricated score):`);
    for (const s of unmapped) console.log(`  - "${s}"`);
    console.log("\nReview each one and add it to UPSTOX_SECTOR_TAXONOMY in upstox-sector-taxonomy.js with an explicit model + reason, then bump UPSTOX_SECTOR_TAXONOMY_VERSION.");
  } else {
    console.log("\nEvery observed sector string is already covered by the current taxonomy.");
  }
  console.log(`\nFull report written to ${out}`);
}

main().catch((err) => {
  console.error("collect-upstox-sectors failed:", err.message);
  process.exit(1);
});

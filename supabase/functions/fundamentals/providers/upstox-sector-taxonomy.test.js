import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";
import { UPSTOX_SECTOR_TAXONOMY_VERSION, UPSTOX_SECTOR_TAXONOMY, classifyUpstoxSector } from "./upstox-sector-taxonomy.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
function fixture(name) {
  return JSON.parse(readFileSync(path.join(__dirname, "__fixtures__", name), "utf-8"));
}

test("classifyUpstoxSector: an unreviewed string returns null (never a guessed model)", () => {
  assert.equal(classifyUpstoxSector("Some Brand New Sector Never Observed"), null);
});

test("classifyUpstoxSector: banks -- both the plural documented form and the singular real-world form resolve to BANK", () => {
  for (const sector of ["Banks", "Bank", "Private Sector Bank", "Public Sector Bank"]) {
    assert.equal(classifyUpstoxSector(sector)?.model, "BANK", `expected ${sector} -> BANK`);
  }
});

test("classifyUpstoxSector: lending-focused financial companies (including housing finance) resolve to NBFC", () => {
  for (const sector of ["Finance", "NBFC", "Financial Services", "Housing Finance"]) {
    assert.equal(classifyUpstoxSector(sector)?.model, "NBFC", `expected ${sector} -> NBFC`);
  }
});

test("classifyUpstoxSector: insurance and genuinely ambiguous non-operating labels resolve to UNSUPPORTED_FALLBACK, never guessed", () => {
  for (const sector of ["Insurance", "Life Insurance", "General Insurance", "Investment", "DVR"]) {
    assert.equal(classifyUpstoxSector(sector)?.model, "UNSUPPORTED_FALLBACK", `expected ${sector} -> UNSUPPORTED_FALLBACK`);
  }
});

test("classifyUpstoxSector: ordinary commercial/industrial sectors resolve to NON_FINANCIAL regardless of specific industry", () => {
  for (const sector of ["Refineries", "Pharmaceuticals", "IT - Software", "Power", "Automobile", "Cement", "Miscellaneous", "Asset Management", "Ratings"]) {
    assert.equal(classifyUpstoxSector(sector)?.model, "NON_FINANCIAL", `expected ${sector} -> NON_FINANCIAL`);
  }
});

test("every taxonomy entry carries a reviewedAt date and a non-empty reason -- no silent/unexplained classification", () => {
  for (const [sector, entry] of Object.entries(UPSTOX_SECTOR_TAXONOMY)) {
    assert.ok(entry.reviewedAt, `${sector} is missing reviewedAt`);
    assert.ok(entry.reason && entry.reason.length > 0, `${sector} is missing a reason`);
    assert.ok(["BANK", "NBFC", "NON_FINANCIAL", "UNSUPPORTED_FALLBACK"].includes(entry.model), `${sector} has an unrecognized model "${entry.model}"`);
  }
});

test("regression: every sector string actually observed live across the real 500-instrument universe (2026-09-16) resolves to a real model, none fall through to null", () => {
  const { sectors, totalInstruments } = fixture("observed-sectors-2026-09-16.json");
  const missing = [];
  const countsByModel = {};
  let totalCounted = 0;
  for (const { sector, count } of sectors) {
    const classification = classifyUpstoxSector(sector);
    if (!classification) {
      missing.push(sector);
      continue;
    }
    countsByModel[classification.model] = (countsByModel[classification.model] ?? 0) + count;
    totalCounted += count;
  }
  assert.deepEqual(missing, [], `these live-observed sector strings are not yet in the taxonomy: ${missing.join(", ")}`);
  assert.equal(totalCounted, totalInstruments);
  // Exact breakdown from the live run this taxonomy update was reviewed
  // against -- a future edit that silently reclassifies an existing entry
  // (e.g. moves "Bank" out of BANK) will change this and must be reviewed,
  // not just accepted because the "missing" check still passes.
  assert.deepEqual(countsByModel, { NON_FINANCIAL: 408, BANK: 26, NBFC: 43, UNSUPPORTED_FALLBACK: 23 });
});

test("UPSTOX_SECTOR_TAXONOMY_VERSION was bumped for this review pass", () => {
  assert.equal(UPSTOX_SECTOR_TAXONOMY_VERSION, "1.1.0");
});

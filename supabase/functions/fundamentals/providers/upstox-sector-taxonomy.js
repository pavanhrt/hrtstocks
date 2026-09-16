// Reviewed, explicit, versioned taxonomy mapping Upstox's free-text
// `sector` field (Get Company Profile) to this project's sector models.
// Every entry is an EXACT string match, reviewed and reasoned individually
// -- never fuzzy-matched. A sector string not listed here is left
// unclassified (mapUpstoxSectorToModel passes it through unchanged) and
// resolves to UNSUPPORTED_FALLBACK -> MANUAL_REVIEW at the score level
// (scoring.js) until it is reviewed and added below.
//
// Bump TAXONOMY_VERSION whenever an entry is added or reclassified, and
// record the reason and review date on the entry itself -- this list is
// the audit trail for "why does company X get scored under model Y."

export const UPSTOX_SECTOR_TAXONOMY_VERSION = "1.0.0";

export const UPSTOX_SECTOR_TAXONOMY = Object.freeze({
  // --- Banks -----------------------------------------------------------
  Banks: { model: "BANK", reviewedAt: "2026-09-16", reason: "deposit-taking/lending bank -- capital adequacy, GNPA/NNPA, NIM apply" },
  "Private Sector Bank": { model: "BANK", reviewedAt: "2026-09-16", reason: "same as Banks -- ownership distinction, not a business-model one" },
  "Public Sector Bank": { model: "BANK", reviewedAt: "2026-09-16", reason: "same as Banks -- ownership distinction, not a business-model one" },

  // --- NBFC / financial-lending -----------------------------------------
  Finance: { model: "NBFC", reviewedAt: "2026-09-16", reason: "lending business without a deposit franchise -- NBFC capital/asset-quality model applies" },
  NBFC: { model: "NBFC", reviewedAt: "2026-09-16", reason: "explicit NBFC classification" },
  "Financial Services": { model: "NBFC", reviewedAt: "2026-09-16", reason: "broad financial-services label observed for lending-oriented companies; reclassify individually if a future observation shows this label used for a non-lending business" },

  // --- Insurance / other regulated-but-unsupported (MANUAL_REVIEW, never
  //     silently scored under a model built for a different business) ----
  Insurance: { model: "UNSUPPORTED_FALLBACK", reviewedAt: "2026-09-16", reason: "insurer -- solvency ratio, claims ratio, and combined ratio are not modeled by any of the three sector models here; needs its own dedicated model before scoring" },
  "Life Insurance": { model: "UNSUPPORTED_FALLBACK", reviewedAt: "2026-09-16", reason: "same as Insurance" },
  "General Insurance": { model: "UNSUPPORTED_FALLBACK", reviewedAt: "2026-09-16", reason: "same as Insurance" },

  // --- Verified ordinary commercial/industrial (NON_FINANCIAL) -----------
  Refineries: {
    model: "NON_FINANCIAL",
    reviewedAt: "2026-09-16",
    reason: "verified live against Reliance Industries (INE002A01018) -- hydrocarbon exploration/refining/petrochemicals/retail/digital services; an ordinary industrial-and-consumer conglomerate with no financial-services characteristics",
  },
});

/** @param {string} sectorString -- an exact Upstox `sector` value. */
export function classifyUpstoxSector(sectorString) {
  return UPSTOX_SECTOR_TAXONOMY[sectorString] ?? null;
}

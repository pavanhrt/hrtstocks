// Sector-model classification for the fundamental score (fundamentals/fundamental-score.yaml).
// PROJECT_DEFAULT -- see that file's own decision_record. This module has no
// dependency on any technical module (indicators.js, structure.js, wave.js,
// etc.) and never will -- see scoring.js's own header for the independence
// guarantee this whole `fundamentals/` tree exists to uphold.
//
// A sector model is resolved from the fundamental snapshot's OWN
// provider-supplied classification (never inferred from technical data, and
// never guessed from a company name). An instrument whose sector cannot be
// classified into one of BANK/NBFC/NON_FINANCIAL lands in
// UNSUPPORTED_FALLBACK, which scores every component as MANUAL_REVIEW --
// applying an ordinary corporate model to an insurer or other regulated
// financial business it was not designed for is exactly the mistake this
// exists to prevent.

export const SECTOR_MODELS = Object.freeze({
  NON_FINANCIAL: "NON_FINANCIAL",
  BANK: "BANK",
  NBFC: "NBFC",
  UNSUPPORTED_FALLBACK: "UNSUPPORTED_FALLBACK",
});

const KNOWN_MODELS = new Set(Object.values(SECTOR_MODELS));

/**
 * @param {string | null | undefined} providerSectorModel -- the fundamental
 *   snapshot's own disclosed sector-model classification (expected to already
 *   be one of SECTOR_MODELS' keys, resolved upstream by whatever ingestion
 *   process normalizes a provider's raw sector/industry taxonomy -- this
 *   function does not itself parse a raw industry string, since guessing a
 *   classification from a free-text industry label risks silently applying
 *   the wrong model to a company the provider never actually classified as a
 *   bank/NBFC).
 * @returns {{ sectorModel: string, resolved: boolean }} resolved=false means
 *   NO_DATA at the caller (no classification was disclosed at all) rather
 *   than a guessed UNSUPPORTED_FALLBACK.
 */
export function resolveSectorModel(providerSectorModel) {
  if (providerSectorModel == null || providerSectorModel === "") {
    return { sectorModel: null, resolved: false };
  }
  if (KNOWN_MODELS.has(providerSectorModel) && providerSectorModel !== SECTOR_MODELS.UNSUPPORTED_FALLBACK) {
    return { sectorModel: providerSectorModel, resolved: true };
  }
  // A disclosed-but-unrecognized classification (e.g. "INSURANCE", "unknown
  // industry code") is a real MANUAL_REVIEW case, not missing data -- the
  // provider DID say something, it just isn't one of the modeled sectors.
  return { sectorModel: SECTOR_MODELS.UNSUPPORTED_FALLBACK, resolved: true };
}

/**
 * Component definitions applicable to a sector model. Banks/NBFCs use their
 * OWN balance_sheet/profitability/growth/cash_flow sub-metric definitions
 * (bank_nbfc_components in the spec -- ordinary corporate ratios never apply
 * to a lending/deposit-taking business), but share the same
 * promoter_governance and future_growth definitions as non-financial
 * companies (components in the spec) -- ownership quality and disclosed
 * forward evidence are evaluated identically regardless of sector.
 * @param {object} spec -- parsed fundamental-score.yaml.
 * @param {string} sectorModel
 */
export function componentDefinitionsFor(spec, sectorModel) {
  if (sectorModel === SECTOR_MODELS.NON_FINANCIAL) {
    return spec.components;
  }
  if (sectorModel === SECTOR_MODELS.BANK || sectorModel === SECTOR_MODELS.NBFC) {
    return {
      balance_sheet: spec.bank_nbfc_components.balance_sheet,
      profitability: spec.bank_nbfc_components.profitability,
      growth: spec.bank_nbfc_components.growth,
      promoter_governance: spec.components.promoter_governance,
      cash_flow: spec.bank_nbfc_components.cash_flow,
      future_growth: spec.components.future_growth,
    };
  }
  return null; // UNSUPPORTED_FALLBACK / unresolved -- caller must not score
}

/** @param {object} spec @param {string} sectorModel */
export function componentWeightsFor(spec, sectorModel) {
  const model = spec.sector_models[sectorModel];
  return model ? model.components : {};
}

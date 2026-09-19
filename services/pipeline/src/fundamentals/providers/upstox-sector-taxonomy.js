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
//
// REVISED 2026-09-16 (v1.1.0): reviewed the real, live sector distribution
// across all 500 currently-ISIN-matched instruments in the 501-stock
// universe (collect-upstox-sectors.mjs, run against the live database after
// the instruments.isin backfill -- see CONTINUATION.md), 103 distinct
// sector strings observed, 0 fetch failures. Classification rule applied
// uniformly: BANK for deposit-taking banks; NBFC for lending-focused
// financial companies without a deposit franchise (including housing
// finance, which is NBFC-model lending under RBI/NHB regulation); every
// ordinary operating company (any industrial, consumer, services,
// technology, healthcare, utility, infrastructure, media, or agricultural
// business, however specific or residual its exact label) as NON_FINANCIAL,
// since the balance-sheet/income-statement ratio model this project uses
// (debt-to-equity, current ratio, ROE, ROCE, operating margin, revenue/PAT
// CAGR, promoter holding, cash flow) is computable and meaningful for any
// normal commercial entity's standard financial statements, regardless of
// which specific industry it operates in; UNSUPPORTED_FALLBACK reserved for
// labels that either denote a genuinely different regulatory/financial
// structure this project has no model for (insurance), or give no reliable
// signal about the underlying business's actual operating-vs-holding
// structure (a pure investment/holding-company label, or a security-class
// flag like DVR that describes the SHARE, not the business) -- guessing
// wrong in either of those two cases risks silently scoring a company whose
// "revenue"/"operating margin" may not mean what the model assumes.

export const UPSTOX_SECTOR_TAXONOMY_VERSION = "1.1.0";

export const UPSTOX_SECTOR_TAXONOMY = Object.freeze({
  // --- Banks -----------------------------------------------------------
  Banks: { model: "BANK", reviewedAt: "2026-09-16", reason: "deposit-taking/lending bank -- capital adequacy, GNPA/NNPA, NIM apply" },
  Bank: { model: "BANK", reviewedAt: "2026-09-16", reason: "the dominant real-world label observed live for deposit-taking banks (e.g. AU Small Finance Bank) -- same model as 'Banks', singular form" },
  "Private Sector Bank": { model: "BANK", reviewedAt: "2026-09-16", reason: "same as Banks -- ownership distinction, not a business-model one" },
  "Public Sector Bank": { model: "BANK", reviewedAt: "2026-09-16", reason: "same as Banks -- ownership distinction, not a business-model one" },

  // --- NBFC / financial-lending -----------------------------------------
  Finance: { model: "NBFC", reviewedAt: "2026-09-16", reason: "lending business without a deposit franchise -- NBFC capital/asset-quality model applies" },
  NBFC: { model: "NBFC", reviewedAt: "2026-09-16", reason: "explicit NBFC classification" },
  "Financial Services": { model: "NBFC", reviewedAt: "2026-09-16", reason: "broad financial-services label observed for lending-oriented companies; reclassify individually if a future observation shows this label used for a non-lending business" },
  "Housing Finance": { model: "NBFC", reviewedAt: "2026-09-16", reason: "mortgage/housing lender regulated as an NBFC (post-NHB-transfer) -- same lending-without-deposits model as NBFC" },

  // --- Insurance / other regulated-but-unsupported, and genuinely
  //     ambiguous non-operating labels (MANUAL_REVIEW, never silently
  //     scored under a model built for a different kind of business) -------
  Insurance: { model: "UNSUPPORTED_FALLBACK", reviewedAt: "2026-09-16", reason: "insurer -- solvency ratio, claims ratio, and combined ratio are not modeled by any of the three sector models here; needs its own dedicated model before scoring" },
  "Life Insurance": { model: "UNSUPPORTED_FALLBACK", reviewedAt: "2026-09-16", reason: "same as Insurance" },
  "General Insurance": { model: "UNSUPPORTED_FALLBACK", reviewedAt: "2026-09-16", reason: "same as Insurance" },
  Investment: {
    model: "UNSUPPORTED_FALLBACK",
    reviewedAt: "2026-09-16",
    reason: "pure investment/holding-company label -- 'revenue' is typically dividend/capital-gains income rather than an operating business's sales, so NON_FINANCIAL's revenue-growth/operating-margin ratios may not mean what the model assumes; needs per-instrument manual review, never a guessed model",
  },
  DVR: {
    model: "UNSUPPORTED_FALLBACK",
    reviewedAt: "2026-09-16",
    reason: "this is a SHARE-CLASS flag (differential voting rights), not an industry -- it discloses nothing about the underlying business (could be an ordinary company, could be something else entirely), so no model can be assigned without looking up the specific instrument",
  },

  // --- Ordinary commercial/industrial (NON_FINANCIAL) -- standard
  //     financial-statement ratios apply regardless of specific industry.
  //     Reviewed live 2026-09-16 against the real 500-instrument sector
  //     distribution; Refineries entry below verified live 2026-09-16
  //     against Reliance Industries (INE002A01018) in an earlier pass. ------
  Refineries: {
    model: "NON_FINANCIAL",
    reviewedAt: "2026-09-16",
    reason: "verified live against Reliance Industries (INE002A01018) -- hydrocarbon exploration/refining/petrochemicals/retail/digital services; an ordinary industrial-and-consumer conglomerate with no financial-services characteristics",
  },
  Pharmaceuticals: { model: "NON_FINANCIAL", reviewedAt: "2026-09-16", reason: "ordinary pharmaceutical manufacturer" },
  Engineering: { model: "NON_FINANCIAL", reviewedAt: "2026-09-16", reason: "ordinary industrial/engineering company" },
  "IT - Software": { model: "NON_FINANCIAL", reviewedAt: "2026-09-16", reason: "ordinary technology/software services company" },
  "IT-Software": { model: "NON_FINANCIAL", reviewedAt: "2026-09-16", reason: "no-space variant of 'IT - Software' -- same classification" },
  "IT - Hardware": { model: "NON_FINANCIAL", reviewedAt: "2026-09-16", reason: "ordinary hardware manufacturer" },
  Power: { model: "NON_FINANCIAL", reviewedAt: "2026-09-16", reason: "power generation/distribution utility -- ordinary commercial financial statements" },
  "Power Generation & Distribution": { model: "NON_FINANCIAL", reviewedAt: "2026-09-16", reason: "same as Power" },
  Chemicals: { model: "NON_FINANCIAL", reviewedAt: "2026-09-16", reason: "ordinary chemicals manufacturer" },
  "Steel & Iron Products": { model: "NON_FINANCIAL", reviewedAt: "2026-09-16", reason: "ordinary metals manufacturer" },
  Metal: { model: "NON_FINANCIAL", reviewedAt: "2026-09-16", reason: "ordinary metals/mining company" },
  "Non Ferrous Metals": { model: "NON_FINANCIAL", reviewedAt: "2026-09-16", reason: "ordinary metals manufacturer" },
  "Aluminium Products": { model: "NON_FINANCIAL", reviewedAt: "2026-09-16", reason: "ordinary metals manufacturer" },
  Minerals: { model: "NON_FINANCIAL", reviewedAt: "2026-09-16", reason: "ordinary mining/minerals company" },
  Automobile: { model: "NON_FINANCIAL", reviewedAt: "2026-09-16", reason: "ordinary automobile manufacturer" },
  Automobiles: { model: "NON_FINANCIAL", reviewedAt: "2026-09-16", reason: "plural variant of Automobile -- same classification" },
  "Auto Ancillary": { model: "NON_FINANCIAL", reviewedAt: "2026-09-16", reason: "ordinary auto-component manufacturer" },
  "Auto Ancillaries": { model: "NON_FINANCIAL", reviewedAt: "2026-09-16", reason: "plural variant of Auto Ancillary -- same classification" },
  "Tyres & Allied": { model: "NON_FINANCIAL", reviewedAt: "2026-09-16", reason: "ordinary tyre manufacturer" },
  "Electric Equipment": { model: "NON_FINANCIAL", reviewedAt: "2026-09-16", reason: "ordinary electrical-equipment manufacturer" },
  "Capital Goods - Electrical Equipment": { model: "NON_FINANCIAL", reviewedAt: "2026-09-16", reason: "same as Electric Equipment" },
  Construction: { model: "NON_FINANCIAL", reviewedAt: "2026-09-16", reason: "ordinary construction/EPC company" },
  "Construction Materials": { model: "NON_FINANCIAL", reviewedAt: "2026-09-16", reason: "ordinary building-materials manufacturer" },
  Cement: { model: "NON_FINANCIAL", reviewedAt: "2026-09-16", reason: "ordinary cement manufacturer" },
  Infrastructure: { model: "NON_FINANCIAL", reviewedAt: "2026-09-16", reason: "ordinary infrastructure company" },
  "Infrastructure Developers & Operators": { model: "NON_FINANCIAL", reviewedAt: "2026-09-16", reason: "same as Infrastructure" },
  "Healthcare Services": { model: "NON_FINANCIAL", reviewedAt: "2026-09-16", reason: "ordinary hospital/diagnostics services company" },
  "Medical Equipment": { model: "NON_FINANCIAL", reviewedAt: "2026-09-16", reason: "ordinary medical-device manufacturer" },
  "Consumer Food": { model: "NON_FINANCIAL", reviewedAt: "2026-09-16", reason: "ordinary food-products company" },
  FMCG: { model: "NON_FINANCIAL", reviewedAt: "2026-09-16", reason: "ordinary fast-moving-consumer-goods company" },
  "Household Products": { model: "NON_FINANCIAL", reviewedAt: "2026-09-16", reason: "ordinary consumer-products company" },
  "Consumer Durables": { model: "NON_FINANCIAL", reviewedAt: "2026-09-16", reason: "ordinary consumer-durables manufacturer" },
  Textile: { model: "NON_FINANCIAL", reviewedAt: "2026-09-16", reason: "ordinary textiles manufacturer" },
  Telecommunication: { model: "NON_FINANCIAL", reviewedAt: "2026-09-16", reason: "ordinary telecom operator" },
  "Telecom-Service": { model: "NON_FINANCIAL", reviewedAt: "2026-09-16", reason: "same as Telecommunication" },
  Diversified: { model: "NON_FINANCIAL", reviewedAt: "2026-09-16", reason: "diversified industrial conglomerate -- ordinary commercial financial statements" },
  Trading: { model: "NON_FINANCIAL", reviewedAt: "2026-09-16", reason: "ordinary trading/incubation company -- standard commercial P&L (revenue, COGS, operating profit) applies" },
  Miscellaneous: { model: "NON_FINANCIAL", reviewedAt: "2026-09-16", reason: "residual industry bucket for an ordinary operating company -- still a normal commercial balance sheet, just not assigned a specific named industry" },
  Retailing: { model: "NON_FINANCIAL", reviewedAt: "2026-09-16", reason: "ordinary retail company" },
  "Asset Management": { model: "NON_FINANCIAL", reviewedAt: "2026-09-16", reason: "AMC -- files standard (non-RBI/IRDAI-format) commercial financial statements; revenue/PAT/equity ratios are computable, even though leverage ratios are less risk-relevant for a low-debt fee business than for a manufacturer" },
  "Stock Broking": { model: "NON_FINANCIAL", reviewedAt: "2026-09-16", reason: "same reasoning as Asset Management -- standard commercial financial statements" },
  "Stock/ Commodity Brokers": { model: "NON_FINANCIAL", reviewedAt: "2026-09-16", reason: "same as Stock Broking" },
  Ratings: { model: "NON_FINANCIAL", reviewedAt: "2026-09-16", reason: "fee-based professional-services company -- ordinary commercial financial statements" },
  Logistics: { model: "NON_FINANCIAL", reviewedAt: "2026-09-16", reason: "ordinary logistics/freight company" },
  "Courier Services": { model: "NON_FINANCIAL", reviewedAt: "2026-09-16", reason: "same as Logistics" },
  Shipping: { model: "NON_FINANCIAL", reviewedAt: "2026-09-16", reason: "ordinary shipping company" },
  "Ship Building": { model: "NON_FINANCIAL", reviewedAt: "2026-09-16", reason: "ordinary shipbuilding company" },
  Port: { model: "NON_FINANCIAL", reviewedAt: "2026-09-16", reason: "ordinary port-operations company" },
  Airlines: { model: "NON_FINANCIAL", reviewedAt: "2026-09-16", reason: "ordinary airline" },
  "Travel Services": { model: "NON_FINANCIAL", reviewedAt: "2026-09-16", reason: "ordinary travel-services company" },
  "BPO/ITeS": { model: "NON_FINANCIAL", reviewedAt: "2026-09-16", reason: "ordinary business-process-outsourcing company" },
  Agrochemicals: { model: "NON_FINANCIAL", reviewedAt: "2026-09-16", reason: "ordinary agrochemicals manufacturer" },
  Agriculture: { model: "NON_FINANCIAL", reviewedAt: "2026-09-16", reason: "ordinary agriculture-sector company" },
  Fertilizers: { model: "NON_FINANCIAL", reviewedAt: "2026-09-16", reason: "ordinary fertilizer manufacturer" },
  Hotel: { model: "NON_FINANCIAL", reviewedAt: "2026-09-16", reason: "ordinary hospitality company" },
  "Hotels & Restaurants": { model: "NON_FINANCIAL", reviewedAt: "2026-09-16", reason: "same as Hotel" },
  "Quick Service Restaurant": { model: "NON_FINANCIAL", reviewedAt: "2026-09-16", reason: "ordinary restaurant/QSR company" },
  "e-Commerce": { model: "NON_FINANCIAL", reviewedAt: "2026-09-16", reason: "ordinary e-commerce company" },
  "E-Commerce/App based Aggregator": { model: "NON_FINANCIAL", reviewedAt: "2026-09-16", reason: "same as e-Commerce" },
  Cable: { model: "NON_FINANCIAL", reviewedAt: "2026-09-16", reason: "ordinary cable manufacturer" },
  "Gases & Fuels": { model: "NON_FINANCIAL", reviewedAt: "2026-09-16", reason: "ordinary industrial-gas/fuel company" },
  "Gas Transmission": { model: "NON_FINANCIAL", reviewedAt: "2026-09-16", reason: "ordinary gas-utility company" },
  "Oil Exploration": { model: "NON_FINANCIAL", reviewedAt: "2026-09-16", reason: "ordinary oil & gas exploration company" },
  "Air Conditioners": { model: "NON_FINANCIAL", reviewedAt: "2026-09-16", reason: "ordinary consumer-durables (HVAC) manufacturer" },
  Batteries: { model: "NON_FINANCIAL", reviewedAt: "2026-09-16", reason: "ordinary battery manufacturer" },
  Paints: { model: "NON_FINANCIAL", reviewedAt: "2026-09-16", reason: "ordinary paints manufacturer" },
  Electronics: { model: "NON_FINANCIAL", reviewedAt: "2026-09-16", reason: "ordinary electronics manufacturer" },
  Breweries: { model: "NON_FINANCIAL", reviewedAt: "2026-09-16", reason: "ordinary beverages/alcohol manufacturer" },
  "Tea/Coffee": { model: "NON_FINANCIAL", reviewedAt: "2026-09-16", reason: "ordinary agri-commodity/beverages company" },
  Sugar: { model: "NON_FINANCIAL", reviewedAt: "2026-09-16", reason: "ordinary sugar manufacturer" },
  Forgings: { model: "NON_FINANCIAL", reviewedAt: "2026-09-16", reason: "ordinary metal-forgings manufacturer" },
  Castings: { model: "NON_FINANCIAL", reviewedAt: "2026-09-16", reason: "ordinary metal-castings manufacturer" },
  "Castings, Forgings & Fastners": { model: "NON_FINANCIAL", reviewedAt: "2026-09-16", reason: "same as Castings/Forgings" },
  Bearings: { model: "NON_FINANCIAL", reviewedAt: "2026-09-16", reason: "ordinary industrial-components manufacturer" },
  "Welding Equipment": { model: "NON_FINANCIAL", reviewedAt: "2026-09-16", reason: "ordinary industrial-equipment manufacturer" },
  Compressors: { model: "NON_FINANCIAL", reviewedAt: "2026-09-16", reason: "ordinary industrial-equipment manufacturer" },
  "Diesel Engines": { model: "NON_FINANCIAL", reviewedAt: "2026-09-16", reason: "ordinary industrial-engines manufacturer" },
  Abrasives: { model: "NON_FINANCIAL", reviewedAt: "2026-09-16", reason: "ordinary industrial-materials manufacturer" },
  Refractories: { model: "NON_FINANCIAL", reviewedAt: "2026-09-16", reason: "ordinary industrial-materials manufacturer" },
  "Carbon Black": { model: "NON_FINANCIAL", reviewedAt: "2026-09-16", reason: "ordinary specialty-chemicals manufacturer" },
  "Plastic Products": { model: "NON_FINANCIAL", reviewedAt: "2026-09-16", reason: "ordinary plastics manufacturer" },
  Glass: { model: "NON_FINANCIAL", reviewedAt: "2026-09-16", reason: "ordinary glass manufacturer" },
  Ceramics: { model: "NON_FINANCIAL", reviewedAt: "2026-09-16", reason: "ordinary ceramics/tiles manufacturer" },
  Lubricants: { model: "NON_FINANCIAL", reviewedAt: "2026-09-16", reason: "ordinary lubricants manufacturer" },
  Stationery: { model: "NON_FINANCIAL", reviewedAt: "2026-09-16", reason: "ordinary consumer-products manufacturer" },
  Footwear: { model: "NON_FINANCIAL", reviewedAt: "2026-09-16", reason: "ordinary footwear manufacturer" },
  Jewellery: { model: "NON_FINANCIAL", reviewedAt: "2026-09-16", reason: "ordinary jewellery retailer/manufacturer" },
  Tobacco: { model: "NON_FINANCIAL", reviewedAt: "2026-09-16", reason: "ordinary tobacco-products company" },
  "TV Broadcasting": { model: "NON_FINANCIAL", reviewedAt: "2026-09-16", reason: "ordinary media/broadcasting company" },
  "Film Production": { model: "NON_FINANCIAL", reviewedAt: "2026-09-16", reason: "ordinary media/entertainment company" },
  Education: { model: "NON_FINANCIAL", reviewedAt: "2026-09-16", reason: "ordinary education-services company" },
  Defence: { model: "NON_FINANCIAL", reviewedAt: "2026-09-16", reason: "ordinary defence-manufacturing company" },
  "Aerospace & Defence": { model: "NON_FINANCIAL", reviewedAt: "2026-09-16", reason: "same as Defence" },
  "Railways Wagons": { model: "NON_FINANCIAL", reviewedAt: "2026-09-16", reason: "ordinary rolling-stock manufacturer" },
});

/** @param {string} sectorString -- an exact Upstox `sector` value. */
export function classifyUpstoxSector(sectorString) {
  return UPSTOX_SECTOR_TAXONOMY[sectorString] ?? null;
}

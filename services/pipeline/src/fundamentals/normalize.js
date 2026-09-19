// Validates a raw fundamental source-snapshot record BEFORE it may be
// stored, per fundamental-score.yaml's data-provenance requirements. This is
// the "import validation" module -- it has no network/database dependency
// and performs no ingestion itself. A future ingestion workflow calls
// `validateSnapshot` on every candidate record before writing it to
// fundamental_source_snapshots, and refuses to store anything that fails.
//
// TIMESTAMP-BASIS CONTRACT (revised 2026-09-16): a snapshot's provenance
// distinguishes four points in time, not two:
//   - period_end: the financial period the figures report on.
//   - publication_timestamp: the filing's actual disclosed publication/
//     submission time -- NULLABLE. A provider that doesn't disclose this
//     (e.g. Upstox) must send null here, never a guessed value.
//   - retrieved_at: when THIS ingestion actually fetched the data.
//   - available_from: the single DEFENSIBLE eligibility timestamp every
//     point-in-time check filters on -- equals publication_timestamp when
//     known, else equals retrieved_at. Always non-null.
//   - timestamp_basis: 'PROVIDER_PUBLICATION' | 'EXCHANGE_FILING' (a real
//     disclosed publication_timestamp backs available_from) or
//     'RETRIEVAL_ONLY' (no disclosed publication_timestamp exists;
//     available_from falls back to retrieved_at). validateSnapshot()
//     enforces internal consistency between these three fields below.
//
// AUDIT STATUS: nullable (undisclosed) -- a provider that doesn't disclose
// whether a filing was audited/limited-review/unaudited must send null,
// never a guessed value ("unaudited" is a real, specific claim, not a safe
// default).

// Fields that must be a real, present, non-empty value.
const STRICT_REQUIRED_FIELDS = [
  "instrument_id",
  "exchange_symbol",
  "source",
  "source_locator", // URL or a stable filing identifier
  "period_end",
  "available_from",
  "timestamp_basis",
  "retrieved_at",
  "period_type", // "annual" | "quarterly" | "ttm"
  "consolidation", // "consolidated" | "standalone"
  "currency",
  "raw_values", // object -- the as-reported figures
  "checksum",
];

// Fields that must exist as an explicit key on the record (forcing every
// provider integration to consciously declare them) but whose value may
// honestly be null when the provider discloses nothing.
const REQUIRED_BUT_NULLABLE_FIELDS = ["audit_status", "publication_timestamp"];

const ENUM_FIELDS = {
  period_type: ["annual", "quarterly", "ttm"],
  consolidation: ["consolidated", "standalone"],
  audit_status: ["audited", "limited_review", "unaudited"], // null is separately allowed -- see REQUIRED_BUT_NULLABLE_FIELDS
  timestamp_basis: ["PROVIDER_PUBLICATION", "EXCHANGE_FILING", "RETRIEVAL_ONLY"],
};

/**
 * @param {object} record
 * @returns {{ valid: boolean, errors: string[] }}
 */
export function validateSnapshot(record) {
  const errors = [];
  if (record == null || typeof record !== "object") {
    return { valid: false, errors: ["record is not an object"] };
  }

  for (const field of STRICT_REQUIRED_FIELDS) {
    const value = record[field];
    if (value === undefined || value === null || value === "") {
      errors.push(`missing required field: ${field}`);
    }
  }
  for (const field of REQUIRED_BUT_NULLABLE_FIELDS) {
    if (!(field in record)) errors.push(`missing required field: ${field} (may be null, but the key must be explicitly present)`);
  }

  for (const [field, allowed] of Object.entries(ENUM_FIELDS)) {
    const value = record[field];
    if (value != null && !allowed.includes(value)) {
      errors.push(`${field} must be one of ${allowed.join("/")}, got "${value}"`);
    }
  }

  if (record.raw_values != null && (typeof record.raw_values !== "object" || Array.isArray(record.raw_values))) {
    errors.push("raw_values must be an object of as-reported figures");
  }
  if (record.raw_values != null && typeof record.raw_values === "object" && Object.keys(record.raw_values).length === 0) {
    errors.push("raw_values must not be empty -- a snapshot with no reported figures carries no evidence");
  }

  if (record.period_end != null && !Number.isFinite(Date.parse(record.period_end))) {
    errors.push("period_end is not a valid date");
  }
  if (record.publication_timestamp != null && !Number.isFinite(Date.parse(record.publication_timestamp))) {
    errors.push("publication_timestamp is not a valid timestamp");
  }
  if (record.available_from != null && !Number.isFinite(Date.parse(record.available_from))) {
    errors.push("available_from is not a valid timestamp");
  }
  if (record.retrieved_at != null && !Number.isFinite(Date.parse(record.retrieved_at))) {
    errors.push("retrieved_at is not a valid timestamp");
  }
  if (
    Number.isFinite(Date.parse(record.publication_timestamp)) &&
    Number.isFinite(Date.parse(record.period_end)) &&
    Date.parse(record.publication_timestamp) < Date.parse(record.period_end)
  ) {
    errors.push("publication_timestamp cannot be before the period it reports on");
  }
  if (
    Number.isFinite(Date.parse(record.retrieved_at)) &&
    Number.isFinite(Date.parse(record.publication_timestamp)) &&
    Date.parse(record.retrieved_at) < Date.parse(record.publication_timestamp)
  ) {
    errors.push("retrieved_at cannot be before publication_timestamp");
  }

  // Timestamp-basis internal consistency -- the basis, publication_timestamp,
  // and available_from must never disagree with each other.
  if (record.timestamp_basis === "RETRIEVAL_ONLY") {
    if (record.publication_timestamp != null) {
      errors.push("timestamp_basis=RETRIEVAL_ONLY requires publication_timestamp to be null -- a null-basis record must never carry a disclosed publication date");
    }
    if (record.available_from != null && record.retrieved_at != null && record.available_from !== record.retrieved_at) {
      errors.push("timestamp_basis=RETRIEVAL_ONLY requires available_from to equal retrieved_at exactly");
    }
  } else if (record.timestamp_basis === "PROVIDER_PUBLICATION" || record.timestamp_basis === "EXCHANGE_FILING") {
    if (record.publication_timestamp == null) {
      errors.push(`timestamp_basis=${record.timestamp_basis} requires a non-null publication_timestamp`);
    }
    if (record.available_from != null && record.publication_timestamp != null && record.available_from !== record.publication_timestamp) {
      errors.push(`timestamp_basis=${record.timestamp_basis} requires available_from to equal publication_timestamp exactly`);
    }
  }

  return { valid: errors.length === 0, errors };
}

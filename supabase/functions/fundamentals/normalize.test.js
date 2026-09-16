import { test } from "node:test";
import assert from "node:assert/strict";
import { validateSnapshot } from "./normalize.js";

function validRecord(overrides = {}) {
  return {
    instrument_id: "abc-123",
    exchange_symbol: "RELIANCE",
    source: "nse-xbrl",
    source_locator: "https://nseindia.com/filing/12345",
    period_end: "2026-03-31",
    publication_timestamp: "2026-05-15T10:00:00Z",
    available_from: "2026-05-15T10:00:00Z",
    timestamp_basis: "EXCHANGE_FILING",
    retrieved_at: "2026-05-16T09:00:00Z",
    period_type: "annual",
    consolidation: "consolidated",
    audit_status: "audited",
    currency: "INR",
    raw_values: { revenue: 100000, net_profit: 12000 },
    checksum: "sha256:deadbeef",
    ...overrides,
  };
}

function retrievalOnlyRecord(overrides = {}) {
  return validRecord({
    publication_timestamp: null,
    available_from: "2026-05-16T09:00:00Z",
    timestamp_basis: "RETRIEVAL_ONLY",
    retrieved_at: "2026-05-16T09:00:00Z",
    audit_status: null,
    ...overrides,
  });
}

test("validateSnapshot: a fully-populated PROVIDER_PUBLICATION/EXCHANGE_FILING record is valid", () => {
  assert.deepEqual(validateSnapshot(validRecord()), { valid: true, errors: [] });
});

test("validateSnapshot: a RETRIEVAL_ONLY record (null publication_timestamp, null audit_status) is valid -- exactly Upstox's own shape", () => {
  assert.deepEqual(validateSnapshot(retrievalOnlyRecord()), { valid: true, errors: [] });
});

test("validateSnapshot: rejects a non-object", () => {
  assert.equal(validateSnapshot(null).valid, false);
  assert.equal(validateSnapshot("x").valid, false);
});

for (const field of [
  "instrument_id", "exchange_symbol", "source", "source_locator", "period_end",
  "available_from", "timestamp_basis", "retrieved_at", "period_type", "consolidation",
  "currency", "raw_values", "checksum",
]) {
  test(`validateSnapshot: rejects a missing "${field}"`, () => {
    const record = validRecord({ [field]: undefined });
    const result = validateSnapshot(record);
    assert.equal(result.valid, false);
    assert.ok(result.errors.some((e) => e.includes(field)));
  });
}

for (const field of ["audit_status", "publication_timestamp"]) {
  test(`validateSnapshot: rejects the KEY "${field}" being entirely absent (even though its value may honestly be null)`, () => {
    const record = validRecord();
    delete record[field];
    const result = validateSnapshot(record);
    assert.equal(result.valid, false);
    assert.ok(result.errors.some((e) => e.includes(field)));
  });
}

test("validateSnapshot: audit_status=null is a valid, honest 'undisclosed' value -- never rejected as missing", () => {
  assert.equal(validateSnapshot(validRecord({ audit_status: null })).valid, true);
});

test("validateSnapshot: rejects an unrecognized enum value instead of silently accepting it", () => {
  assert.equal(validateSnapshot(validRecord({ period_type: "biannual" })).valid, false);
  assert.equal(validateSnapshot(validRecord({ consolidation: "combined" })).valid, false);
  assert.equal(validateSnapshot(validRecord({ audit_status: "self-certified" })).valid, false);
  assert.equal(validateSnapshot(validRecord({ timestamp_basis: "GUESSED" })).valid, false);
});

test("validateSnapshot: rejects empty raw_values -- a snapshot with no reported figures carries no evidence", () => {
  assert.equal(validateSnapshot(validRecord({ raw_values: {} })).valid, false);
});

test("validateSnapshot: rejects raw_values that isn't a plain object", () => {
  assert.equal(validateSnapshot(validRecord({ raw_values: [1, 2, 3] })).valid, false);
});

test("validateSnapshot: rejects publication_timestamp before the period it reports on", () => {
  const result = validateSnapshot(validRecord({ period_end: "2026-06-30", publication_timestamp: "2026-01-01T00:00:00Z", available_from: "2026-01-01T00:00:00Z" }));
  assert.equal(result.valid, false);
  assert.ok(result.errors.some((e) => e.includes("before the period")));
});

test("validateSnapshot: rejects retrieved_at before publication_timestamp", () => {
  const result = validateSnapshot(validRecord({ publication_timestamp: "2026-05-15T10:00:00Z", retrieved_at: "2026-05-14T00:00:00Z" }));
  assert.equal(result.valid, false);
  assert.ok(result.errors.some((e) => e.includes("retrieved_at")));
});

test("validateSnapshot: rejects an unparseable date", () => {
  assert.equal(validateSnapshot(validRecord({ period_end: "not-a-date" })).valid, false);
});

// --- Timestamp-basis internal consistency ----------------------------------

test("validateSnapshot: rejects RETRIEVAL_ONLY with a non-null publication_timestamp -- never disclose a fabricated filing date under a null-basis record", () => {
  const result = validateSnapshot(retrievalOnlyRecord({ publication_timestamp: "2026-05-15T10:00:00Z" }));
  assert.equal(result.valid, false);
  assert.ok(result.errors.some((e) => e.includes("RETRIEVAL_ONLY")));
});

test("validateSnapshot: rejects RETRIEVAL_ONLY where available_from does not exactly equal retrieved_at", () => {
  const result = validateSnapshot(retrievalOnlyRecord({ available_from: "2026-05-16T08:00:00Z", retrieved_at: "2026-05-16T09:00:00Z" }));
  assert.equal(result.valid, false);
});

test("validateSnapshot: rejects PROVIDER_PUBLICATION/EXCHANGE_FILING with a null publication_timestamp", () => {
  const result = validateSnapshot(validRecord({ timestamp_basis: "EXCHANGE_FILING", publication_timestamp: null }));
  assert.equal(result.valid, false);
  assert.ok(result.errors.some((e) => e.includes("EXCHANGE_FILING")));
});

test("validateSnapshot: rejects PROVIDER_PUBLICATION/EXCHANGE_FILING where available_from does not exactly equal publication_timestamp", () => {
  const result = validateSnapshot(validRecord({ available_from: "2026-05-15T00:00:00Z", publication_timestamp: "2026-05-15T10:00:00Z" }));
  assert.equal(result.valid, false);
});

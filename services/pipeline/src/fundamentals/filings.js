// Point-in-time filing selection for the fundamental score. Guarantees no
// look-ahead bias: a score computed for a given cutoff may only use filings
// whose `available_from` is on or before that cutoff, and a later
// filing/revision must never be selected for an earlier cutoff -- this is
// the mechanism that makes "a fundamental score for a screening run may use
// only filings available on or before that run's cutoff" true, and that an
// already-published run's score is immutable against later filings (a later
// filing simply never gets selected when this function is re-run with the
// SAME historical cutoff; it can only affect NEW computations at a LATER
// cutoff).
//
// REVISED 2026-09-16 (timestamp-basis correction): filters on
// `available_from`, not `publication_timestamp` directly -- available_from
// is the single, always-non-null eligibility timestamp (equal to
// publication_timestamp when a real filing date is known, or to
// retrieved_at when it is not -- see normalize.js/upstox-normalize.js).
// `publication_timestamp` itself is preserved on each filing purely for
// display/provenance and may be null.
//
// A "filing" here is one normalized fundamental snapshot for one instrument,
// one financial period, one consolidation type (consolidated/standalone),
// carrying its own available_from and optional supersedes_id (set when a
// filing is a revision of an earlier one).

/**
 * @param {Array<{id: string, period_end: string, available_from: string, publication_timestamp?: string|null, timestamp_basis?: string, consolidation: "consolidated"|"standalone", supersedes_id?: string|null}>} filings
 * @param {string} cutoffIso -- ISO timestamp; only filings available on or before this are eligible.
 * @returns {object|null} the single applicable filing, or null if none is eligible.
 */
export function selectApplicableFiling(filings, cutoffIso) {
  const cutoffMs = Date.parse(cutoffIso);
  if (!Number.isFinite(cutoffMs)) throw new Error(`selectApplicableFiling: invalid cutoff "${cutoffIso}"`);

  const eligible = filings.filter((f) => {
    const availableMs = Date.parse(f.available_from);
    return Number.isFinite(availableMs) && availableMs <= cutoffMs;
  });
  if (eligible.length === 0) return null;

  // A revision (supersedes_id set) only counts if ITS OWN availability is
  // within the eligible set above -- already guaranteed by the filter, since
  // a revision is just another row with its own available_from. If both an
  // original and its eligible revision exist, the revision (being the more
  // complete/corrected record of the same period) wins.
  const latestPeriodEnd = eligible.reduce((max, f) => (Date.parse(f.period_end) > Date.parse(max) ? f.period_end : max), eligible[0].period_end);
  const sameLatestPeriod = eligible.filter((f) => f.period_end === latestPeriodEnd);

  // Prefer consolidated over standalone for the same period (AGENTS.md-style
  // evidence priority: a company's own most complete statement outranks a
  // narrower one when both exist).
  const consolidated = sameLatestPeriod.filter((f) => f.consolidation === "consolidated");
  const pool = consolidated.length > 0 ? consolidated : sameLatestPeriod;

  // Within the pool, prefer whichever was superseded-by another eligible
  // filing for the exact same period (i.e. prefer a revision over the
  // original it revises, when both are eligible).
  const revisedIds = new Set(pool.filter((f) => f.supersedes_id).map((f) => f.supersedes_id));
  const nonSuperseded = pool.filter((f) => !revisedIds.has(f.id));
  const finalPool = nonSuperseded.length > 0 ? nonSuperseded : pool;

  // Deterministic tie-break: latest available_from wins.
  return finalPool.reduce((latest, f) => (Date.parse(f.available_from) > Date.parse(latest.available_from) ? f : latest), finalPool[0]);
}

/** True if `filings` includes only a standalone statement for the selected period (no consolidated statement exists at all). */
export function isStandaloneOnly(filings, selected) {
  if (!selected) return false;
  const samePeriod = filings.filter((f) => f.period_end === selected.period_end);
  return !samePeriod.some((f) => f.consolidation === "consolidated");
}

/** True when a filing's timestamp_basis means it is NOT historically point-in-time reliable (e.g. Upstox's RETRIEVAL_ONLY records) -- callers should disclose this on the detail page. */
export function isRetrievalOnly(filing) {
  return filing?.timestamp_basis === "RETRIEVAL_ONLY";
}

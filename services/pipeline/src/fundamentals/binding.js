// Deterministic, version-pinning selection of which fundamental_score_results
// row a given screening run should bind to for one instrument -- the exact
// logic the SQL function bind_fundamental_scores_for_refresh() (migration
// 0014) mirrors mechanically. Kept here, tested directly, so the selection
// RULE itself is verified without a live database; the SQL is a direct
// translation, not an independent reimplementation.
//
// Why a binding table instead of "order by cutoff_at desc limit 1" at read
// time (the bug this file fixes): a dynamic ORDER BY is recomputed on every
// read. If a second score_version's results start appearing for cutoffs
// that overlap an already-displayed screening run, a plain "latest cutoff"
// query can silently start returning a DIFFERENT row for that same run on a
// later page load -- an already-published run's fundamental evidence must
// never change. Resolving the binding ONCE (this function) and persisting it
// (buy_setup_fundamental_score_bindings, insert-only, trigger-enforced
// immutable) makes the choice permanent regardless of what score versions or
// filings arrive afterward.

/**
 * @param {{id: number, instrument_id: string, cutoff_at: string, score_version_id: number}[]} candidates
 *   every fundamental_score_results row for one instrument, across every score version.
 * @param {string} runAsOfIso -- the screening run's own as_of_timestamp.
 * @returns {{id:number, instrument_id:string, cutoff_at:string, score_version_id:number}|null}
 *   the single result to bind, or null if nothing is eligible (NO_DATA).
 */
export function resolveFundamentalBinding(candidates, runAsOfIso) {
  const runAsOfMs = Date.parse(runAsOfIso);
  if (!Number.isFinite(runAsOfMs)) throw new Error(`resolveFundamentalBinding: invalid runAsOfIso "${runAsOfIso}"`);

  const eligible = candidates.filter((c) => {
    const cutoffMs = Date.parse(c.cutoff_at);
    return Number.isFinite(cutoffMs) && cutoffMs <= runAsOfMs;
  });
  if (eligible.length === 0) return null;

  // Latest eligible cutoff wins, regardless of which score_version it came
  // from -- a newer score_version's result is only preferred if it is ALSO
  // the most information-rich (latest) cutoff available; an older version's
  // result at a later cutoff still outranks a newer version's result at an
  // earlier one, since "most recent evidence, correctly gated by cutoff" is
  // the point-in-time-correct choice, not "most recent version."
  // Deterministic tie-break when two candidates share the exact same
  // cutoff_at (e.g. a version bump recomputed the same cutoff): higher
  // score_version_id (the newer version) wins.
  return eligible.reduce((best, c) => {
    if (!best) return c;
    const bestCutoff = Date.parse(best.cutoff_at);
    const cCutoff = Date.parse(c.cutoff_at);
    if (cCutoff > bestCutoff) return c;
    if (cCutoff === bestCutoff && c.score_version_id > best.score_version_id) return c;
    return best;
  }, null);
}

// Atomic run leasing, backed by screening_run_leases (migration 0006).
// Replaces the non-atomic "select status='running' then insert" check added
// earlier this session (which left 5 concurrent runs hammering Fyers
// simultaneously before it could be hand-fixed via SQL) with a single
// UPDATE ... WHERE ... RETURNING: PostgREST translates
// `.update(...).eq(...).or(...)` into one SQL statement, so Postgres' own
// row-level locking makes the acquire atomic -- two concurrent callers can
// never both succeed for the same run_type, and there is no read-then-write
// window between "check if free" and "claim it".
//
// Gracefully degrades (acquires unconditionally, `coordinated: false`) if
// migration 0006 isn't applied yet, per this project's requirement to
// handle a missing migration without hard-failing the pipeline.

const TABLE_NOT_FOUND = "PGRST205";

/**
 * @param {import("@supabase/supabase-js").SupabaseClient} supabase
 * @param {string} runType e.g. "eod_screening"
 * @param {string} runId
 * @param {{leaseDurationMs?: number}} [options]
 * @returns {Promise<{acquired: boolean, coordinated: boolean}>}
 */
export async function acquireRunLease(supabase, runType, runId, { leaseDurationMs = 10 * 60 * 1000 } = {}) {
  const nowIso = new Date().toISOString();
  const expiresAtIso = new Date(Date.now() + leaseDurationMs).toISOString();

  const { data, error } = await supabase
    .from("screening_run_leases")
    .update({ status: "active", run_id: runId, acquired_at: nowIso, heartbeat_at: nowIso, expires_at: expiresAtIso })
    .eq("run_type", runType)
    .or(`status.eq.released,expires_at.lt.${nowIso}`)
    .select()
    .maybeSingle();

  if (error) {
    if (error.code === TABLE_NOT_FOUND) return { acquired: true, coordinated: false };
    throw error;
  }
  return { acquired: !!data, coordinated: true };
}

/** Extends an already-held lease's expiry -- call periodically during a long run so it isn't mistaken for abandoned. */
export async function heartbeatRunLease(supabase, runType, { leaseDurationMs = 10 * 60 * 1000 } = {}) {
  const { error } = await supabase
    .from("screening_run_leases")
    .update({ heartbeat_at: new Date().toISOString(), expires_at: new Date(Date.now() + leaseDurationMs).toISOString() })
    .eq("run_type", runType)
    .eq("status", "active");
  if (error && error.code !== TABLE_NOT_FOUND) throw error;
}

/** Releases a held lease on clean completion (success or handled failure) so the next run doesn't wait for expiry. */
export async function releaseRunLease(supabase, runType) {
  const { error } = await supabase.from("screening_run_leases").update({ status: "released" }).eq("run_type", runType);
  if (error && error.code !== TABLE_NOT_FOUND) throw error;
}

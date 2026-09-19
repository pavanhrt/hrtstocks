// Atomic run leasing, backed by screening_run_leases (migration 0006).
// A single UPDATE ... WHERE ... RETURNING: Postgres' own row-level locking
// makes the acquire atomic -- two concurrent callers can never both succeed for
// the same run_type, and there is no read-then-write window between "check if
// free" and "claim it". (This replaced a non-atomic select-then-insert check
// that let five concurrent runs hammer the data provider at once.)
//
// With Cloud Run Jobs the lease still matters: a manual click while the
// scheduled run is executing, or an overlapping scheduler tick, must not start
// a second pipeline.

/**
 * @param {import("../db/client.js").Db} db
 * @param {string} runType e.g. "eod_screening"
 * @param {string} runId
 * @param {{leaseDurationMs?: number}} [options]
 * @returns {Promise<{acquired: boolean}>}
 */
export async function acquireRunLease(db, runType, runId, { leaseDurationMs = 10 * 60 * 1000 } = {}) {
  const now = new Date();
  const expiresAt = new Date(now.getTime() + leaseDurationMs);
  const row = await db.one(
    `update screening_run_leases
        set status = 'active', run_id = $2, acquired_at = $3, heartbeat_at = $3, expires_at = $4
      where run_type = $1 and (status = 'released' or expires_at < $3)
      returning run_type`,
    [runType, runId, now.toISOString(), expiresAt.toISOString()],
  );
  return { acquired: row !== null };
}

/** Extends an already-held lease's expiry -- call periodically during a long run so it isn't mistaken for abandoned. */
export async function heartbeatRunLease(db, runType, runId, { leaseDurationMs = 10 * 60 * 1000 } = {}) {
  await db.query(
    `update screening_run_leases set heartbeat_at = $3, expires_at = $4
      where run_type = $1 and run_id = $2 and status = 'active'`,
    [runType, runId, new Date().toISOString(), new Date(Date.now() + leaseDurationMs).toISOString()],
  );
}

/** Releases a held lease on clean completion (success or handled failure) so the next run doesn't wait for expiry. */
export async function releaseRunLease(db, runType, runId) {
  await db.query(
    `update screening_run_leases set status = 'released' where run_type = $1 and run_id = $2 and status = 'active'`,
    [runType, runId],
  );
}

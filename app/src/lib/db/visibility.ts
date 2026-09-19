/**
 * Explicit replacement for the Supabase row-level-security policies
 * (0002_rls.sql, 0010, 0011, 0014 -- ported in db/migrations without policies).
 *
 * Every read in the app goes through a repository that receives the verified
 * `Viewer` and applies these rules in SQL. Nothing is inferred from anything the
 * browser sends. The rules, exactly as the RLS policies stated them:
 *
 *  1. Staff-only tables (researcher, strategy_admin, system_admin): pipeline
 *     internals, market bars, data-quality results, audit log, fundamentals inputs.
 *  2. Run-scoped tables: a viewer sees a run's rows only once the run is
 *     `published`; staff see every run.
 *  3. Buy-setup enrichment tables: same, keyed on the enrichment manifest's
 *     `enrichment_state = 'published'`.
 *  4. Fundamentals results/bindings: visible when their refresh manifest is
 *     published (staff additionally see unmanifested/unpublished ones).
 *  5. profiles: a user reads their own row; only system_admin reads or updates others.
 *  6. Everything else (strategies, rules, instruments, direction summaries, FOME
 *     analyses): any authenticated user.
 *
 * Repositories bind `viewer.staff` as a query parameter and use the SQL builders
 * below; `visibility.test.ts` proves each rule against a real Postgres.
 */
export type UserRole = "viewer" | "researcher" | "strategy_admin" | "system_admin";

export type Viewer = {
  /** profiles.id (internal uuid) -- never a browser-supplied value. */
  userId: string;
  role: UserRole;
};

export const STAFF_ROLES: readonly UserRole[] = ["researcher", "strategy_admin", "system_admin"];

export function isStaff(viewer: Pick<Viewer, "role">): boolean {
  return STAFF_ROLES.includes(viewer.role);
}

/**
 * SQL predicate: rows of `alias` whose `run_id` belongs to a run this viewer may
 * see. `staffParam` is the `$n` placeholder bound to isStaff(viewer).
 */
export function runVisibleSql(alias: string, staffParam: string): string {
  return `(${staffParam}::boolean or exists (select 1 from screening_runs vr where vr.id = ${alias}.run_id and vr.publication_state = 'published'))`;
}

/** Same for tables scoped to a buy-setup enrichment manifest (`run_id` -> buy_setup_manifests). */
export function buySetupVisibleSql(alias: string, staffParam: string): string {
  return `(${staffParam}::boolean or exists (select 1 from buy_setup_manifests vm where vm.run_id = ${alias}.run_id and vm.enrichment_state = 'published'))`;
}

/** Fundamentals results: published refresh manifest, or staff for unmanifested/unpublished rows. */
export function fundamentalResultVisibleSql(alias: string, staffParam: string): string {
  return `(${staffParam}::boolean or exists (select 1 from fundamental_refresh_manifests vf where vf.id = ${alias}.refresh_manifest_id and vf.refresh_state = 'published'))`;
}

/** Marker for repository functions whose data is staff-only: they return `empty` to non-staff (what RLS did). */
export function staffOnly<T>(viewer: Viewer, empty: T, run: () => Promise<T>): Promise<T> {
  return isStaff(viewer) ? run() : Promise.resolve(empty);
}

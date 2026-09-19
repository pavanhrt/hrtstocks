import type { Db } from "./db/pool.ts";
import type { UserRole } from "./db/visibility.ts";

/** A token-verified identity from Identity Platform (never browser-asserted fields). */
export type VerifiedIdentity = { uid: string; email: string; emailVerified: boolean };

export type AuthorizedUser = { id: string; email: string; role: UserRole };

export type SignupMode = "invite_only" | "open";

const COLUMNS = "id, email, role";

/**
 * Maps a verified identity to an authorized application user, or null.
 *
 * Invite-only (default): a person may sign in only if an administrator already
 * created their profile (invite), or their email is in bootstrap_admin_emails.
 * Open signup (SIGNUP_MODE=open) additionally creates a `viewer` profile -- it
 * must stay off until email verification, abuse controls, authorization tests and
 * cost controls are ready (docs/gcp/authentication.md).
 *
 * Linking a profile to a UID by email requires `emailVerified`, so an attacker
 * cannot claim someone else's invite by registering their address unverified.
 * Every step is a single atomic statement, so concurrent first logins cannot
 * create duplicates (unique indexes on auth_uid and lower(email)).
 */
export async function resolveAuthorizedUser(
  db: Db,
  identity: VerifiedIdentity,
  { signupMode = "invite_only" }: { signupMode?: SignupMode } = {},
): Promise<AuthorizedUser | null> {
  const email = identity.email.trim();
  if (!identity.uid || !email) return null;

  const existing = await db.one<AuthorizedUser>(`select ${COLUMNS} from profiles where auth_uid = $1`, [identity.uid]);
  if (existing) return existing;

  // Anything beyond "already linked" needs a verified email.
  if (!identity.emailVerified) return null;

  const linked = await db.one<AuthorizedUser>(
    `update profiles set auth_uid = $1
      where lower(email) = lower($2) and auth_uid is null
      returning ${COLUMNS}`,
    [identity.uid, email],
  );
  if (linked) return linked;

  const bootstrap = await db.one<AuthorizedUser>(
    `insert into profiles (email, role, auth_uid)
     select $2, 'system_admin', $1
      where exists (select 1 from bootstrap_admin_emails b where lower(b.email) = lower($2))
     on conflict do nothing
     returning ${COLUMNS}`,
    [identity.uid, email],
  );
  if (bootstrap) return bootstrap;

  if (signupMode === "open") {
    const created = await db.one<AuthorizedUser>(
      `insert into profiles (email, role, auth_uid) values ($2, 'viewer', $1)
       on conflict do nothing
       returning ${COLUMNS}`,
      [identity.uid, email],
    );
    if (created) return created;
  }

  // A different UID may already own this email's profile: never take it over.
  return null;
}

/** Per-request lookup for an already-linked user (role is always read fresh from the database). */
export async function findLinkedUser(db: Db, uid: string): Promise<AuthorizedUser | null> {
  if (!uid) return null;
  return db.one<AuthorizedUser>(`select ${COLUMNS} from profiles where auth_uid = $1`, [uid]);
}

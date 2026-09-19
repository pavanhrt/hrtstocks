import type { Db } from "./db/pool.ts";
import type { UserRole } from "./db/visibility.ts";

/** The slice of the Firebase Admin Auth API this needs (kept narrow so it can be faked in tests). */
export type InviteAuth = {
  getUserByEmail(email: string): Promise<{ uid: string }>;
  createUser(properties: { email: string; emailVerified: boolean; disabled: boolean }): Promise<{ uid: string }>;
  generatePasswordResetLink(email: string): Promise<string>;
};

const ROLES: readonly UserRole[] = ["viewer", "researcher", "strategy_admin", "system_admin"];
const EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

export type InviteResult = { profileId: string; uid: string; createdAccount: boolean; resetLink: string | null };

/**
 * Invite-only onboarding for an administrator: creates (or updates the role of) the person's profile
 * and their identity account. Does NOT send any e-mail: with `includeResetLink` it returns a
 * one-time password-set link for the administrator to deliver through a channel of their choice.
 * The person can then sign in; on first verified sign-in their account is linked to this profile.
 */
export async function inviteUser(
  db: Db,
  auth: InviteAuth,
  { email, role, includeResetLink = false }: { email: string; role: string; includeResetLink?: boolean },
): Promise<InviteResult> {
  const normalized = email.trim().toLowerCase();
  if (!EMAIL.test(normalized) || normalized.length > 254) throw new Error("A valid e-mail address is required.");
  if (!ROLES.includes(role as UserRole)) throw new Error(`role must be one of: ${ROLES.join(", ")}`);

  const profile = await db.one<{ id: string }>(
    `insert into profiles (email, role) values ($1, $2::user_role)
     on conflict (lower(email)) do update set role = excluded.role
     returning id`,
    [normalized, role],
  );

  let uid: string;
  let createdAccount = false;
  try {
    uid = (await auth.getUserByEmail(normalized)).uid;
  } catch (err) {
    if ((err as { code?: string }).code !== "auth/user-not-found") throw err;
    uid = (await auth.createUser({ email: normalized, emailVerified: false, disabled: false })).uid;
    createdAccount = true;
  }

  return { profileId: profile!.id, uid, createdAccount, resetLink: includeResetLink ? await auth.generatePasswordResetLink(normalized) : null };
}

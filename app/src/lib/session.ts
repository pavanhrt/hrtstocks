import type { AuthorizedUser } from "./auth-profile.ts";

/**
 * Turns the opaque session cookie into an authorized user, or null. Pure (dependencies are injected)
 * so the forgery/expiry/revocation behavior is unit-testable without a Next.js request.
 *
 * `verify` must check signature, expiry AND revocation (Admin SDK `verifySessionCookie(cookie, true)`).
 * Anything that throws means "not authenticated": a forged, tampered, expired, revoked, or wrong-project cookie
 * can never yield a user. The role always comes from our own database via `find`, never from the cookie.
 */
export async function resolveSessionUser(
  cookie: string | undefined,
  deps: {
    verify: (cookie: string) => Promise<{ uid: string }>;
    find: (uid: string) => Promise<AuthorizedUser | null>;
  },
): Promise<AuthorizedUser | null> {
  if (!cookie) return null;
  let uid: string;
  try {
    ({ uid } = await deps.verify(cookie));
  } catch {
    return null;
  }
  if (!uid) return null;
  return deps.find(uid);
}

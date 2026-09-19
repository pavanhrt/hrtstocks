import { cache } from "react";
import { cookies } from "next/headers";
import { redirect } from "next/navigation";
import { serverConfig } from "./config.ts";
import { getDb } from "./db/pool.ts";
import { findLinkedUser } from "./auth-profile.ts";
import { resolveSessionUser } from "./session.ts";
import { adminAuth } from "./firebase/admin.ts";
import type { UserRole } from "./db/visibility.ts";

export type { UserRole } from "./db/visibility.ts";

export type CurrentUser = {
  id: string;
  email: string;
  role: UserRole;
};

const ROLE_RANK: Record<UserRole, number> = {
  viewer: 0,
  researcher: 1,
  strategy_admin: 2,
  system_admin: 3,
};

export function roleAtLeast(role: UserRole, minimum: UserRole) {
  return ROLE_RANK[role] >= ROLE_RANK[minimum];
}

/**
 * The verified user for this request, or null when signed out.
 *
 * The browser only ever presents an opaque session cookie. It is verified here
 * with the Admin SDK (signature, expiry AND revocation), and the role is read
 * from our own database on every request -- nothing about identity or
 * authorization is trusted from the client. Every authenticated page / route /
 * repository must go through this (directly or via ../access.ts).
 */
export const getCurrentUser = cache(async (): Promise<CurrentUser | null> => {
  const jar = await cookies(); // first: marks the render as request-time (never prerendered)
  const cfg = serverConfig();
  return resolveSessionUser(jar.get(cfg.SESSION_COOKIE_NAME)?.value, {
    verify: (cookie) => adminAuth().verifySessionCookie(cookie, true), // signature, expiry AND revocation
    find: (uid) => findLinkedUser(getDb(), uid),
  });
});

/** Server Action / Route Handler guard: redirects to /login if signed out, throws if under-privileged. */
export async function requireRole(minimum: UserRole): Promise<CurrentUser> {
  const user = await getCurrentUser();
  if (!user) redirect("/login");
  if (!roleAtLeast(user.role, minimum)) {
    throw new Error(`This action requires the ${minimum} role or higher.`);
  }
  return user;
}

export type ApiAuthResult = { ok: true; user: CurrentUser } | { ok: false; status: 401 | 403; error: string };

/** API-route variant of requireRole: never redirects, returns the HTTP status to send instead. */
export async function authorizeApi(minimum: UserRole): Promise<ApiAuthResult> {
  const user = await getCurrentUser();
  if (!user) return { ok: false, status: 401, error: "Sign in required." };
  if (!roleAtLeast(user.role, minimum)) return { ok: false, status: 403, error: `This action requires the ${minimum} role or higher.` };
  return { ok: true, user };
}

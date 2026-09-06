import { redirect } from "next/navigation";
import { createClient } from "@/lib/supabase/server";
import type { Enums } from "@/lib/database.types";

export type UserRole = Enums<"user_role">;

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

/** Returns null when signed out. Every authenticated page/route should redirect on null. */
export async function getCurrentUser(): Promise<CurrentUser | null> {
  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) return null;

  const { data: profile } = await supabase
    .from("profiles")
    .select("role, email")
    .eq("id", user.id)
    .single();

  // A signed-in auth.users row always gets a profiles row via the
  // handle_new_user trigger, so this only happens mid-race right after signup.
  if (!profile) return { id: user.id, email: user.email ?? "", role: "viewer" };

  return { id: user.id, email: profile.email, role: profile.role };
}

/** Server Action / Route Handler guard: redirects to /login if signed out, throws if under-privileged. */
export async function requireRole(minimum: UserRole): Promise<CurrentUser> {
  const user = await getCurrentUser();
  if (!user) redirect("/login");
  if (!roleAtLeast(user.role, minimum)) {
    throw new Error(`This action requires the ${minimum} role or higher.`);
  }
  return user;
}

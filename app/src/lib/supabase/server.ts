import { createServerClient } from "@supabase/ssr";
import { cookies } from "next/headers";
import type { Database } from "@/lib/database.types";
import { SUPABASE_URL, SUPABASE_ANON_KEY } from "@/lib/env";

// Server Components can only read cookies (Next.js forbids setting them there),
// so setAll is wrapped in a try/catch. Any session refresh that would need to
// write a cookie from a Server Component is instead handled by middleware.ts.
export async function createClient() {
  const cookieStore = await cookies();

  return createServerClient<Database>(
    SUPABASE_URL,
    SUPABASE_ANON_KEY,
    {
      cookies: {
        getAll() {
          return cookieStore.getAll();
        },
        setAll(cookiesToSet) {
          try {
            cookiesToSet.forEach(({ name, value, options }) => cookieStore.set(name, value, options));
          } catch {
            // called from a Server Component; middleware.ts handles refresh instead
          }
        },
      },
    }
  );
}

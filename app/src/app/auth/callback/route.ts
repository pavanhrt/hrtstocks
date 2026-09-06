import { NextResponse } from "next/server";
import { createClient } from "@/lib/supabase/server";

// Supabase auth emails (confirm signup, password recovery) redirect here with
// a `code` param; exchanging it sets the session cookie via @supabase/ssr.
export async function GET(request: Request) {
  const { searchParams, origin } = new URL(request.url);
  const code = searchParams.get("code");
  const next = searchParams.get("next") ?? "/dashboard";

  if (code) {
    const supabase = await createClient();
    await supabase.auth.exchangeCodeForSession(code);
  }

  return NextResponse.redirect(`${origin}${next}`);
}

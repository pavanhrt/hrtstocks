import { NextResponse } from "next/server";
import { requireRole } from "@/lib/auth";

// POST /api/screening-runs -- manual "Run now" (Researcher and above).
// Deliberately thin: this route only authenticates/authorizes the request and
// forwards it to the run-screening Edge Function using the project's secret
// key, which never reaches the browser. The Edge Function itself creates the
// screening_runs row and does all the ingestion/rule-evaluation work -- see
// supabase/functions/run-screening/index.js.
//
// SUPABASE_SECRET_KEY here is the new-style `sb_secret_...` key (Settings ->
// API Keys -> "Publishable and secret API keys" tab), not the deprecated
// legacy service_role JWT -- this project has migrated to Supabase's
// JWT-signing-key system, where the legacy key no longer resolves to a
// usable value on the Edge Function side (confirmed directly against the
// project's Edge Functions > Secrets page, which marks it "Deprecated").
export async function POST() {
  let user;
  try {
    user = await requireRole("researcher");
  } catch (err) {
    return NextResponse.json({ error: err instanceof Error ? err.message : "Forbidden" }, { status: 403 });
  }

  const functionUrl = process.env.RUN_SCREENING_FUNCTION_URL;
  const secretKey = process.env.SUPABASE_SECRET_KEY;
  if (!functionUrl || !secretKey) {
    return NextResponse.json(
      { error: "RUN_SCREENING_FUNCTION_URL / SUPABASE_SECRET_KEY not configured" },
      { status: 500 }
    );
  }

  const res = await fetch(functionUrl, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${secretKey}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({ trigger_type: "manual", triggered_by: user.id }),
  });

  if (!res.ok) {
    const text = await res.text().catch(() => "");
    return NextResponse.json({ error: `Edge Function returned ${res.status}: ${text}` }, { status: 502 });
  }

  const body = await res.json().catch(() => ({}));
  return NextResponse.json(body);
}

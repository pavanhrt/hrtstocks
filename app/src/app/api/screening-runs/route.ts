import { NextResponse } from "next/server";
import { requireRole } from "@/lib/auth";

// POST /api/screening-runs -- manual "Run now" (Researcher and above).
// Deliberately thin: this route only authenticates/authorizes the request and
// forwards it to the run-screening Edge Function using the service role key,
// which never reaches the browser. The Edge Function itself creates the
// screening_runs row and does all the ingestion/rule-evaluation work -- see
// supabase/functions/run-screening/index.js.
export async function POST() {
  let user;
  try {
    user = await requireRole("researcher");
  } catch (err) {
    return NextResponse.json({ error: err instanceof Error ? err.message : "Forbidden" }, { status: 403 });
  }

  const functionUrl = process.env.RUN_SCREENING_FUNCTION_URL;
  const serviceRoleKey = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!functionUrl || !serviceRoleKey) {
    return NextResponse.json(
      { error: "RUN_SCREENING_FUNCTION_URL / SUPABASE_SERVICE_ROLE_KEY not configured" },
      { status: 500 }
    );
  }

  const res = await fetch(functionUrl, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${serviceRoleKey}`,
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

import { NextResponse } from "next/server";
import { requireRole } from "@/lib/auth";
import { getLatestPublishedRun } from "@/lib/data/runs";

// POST /api/buy-setup-analysis -- manual "Run buy-setup analysis" trigger
// (Researcher and above). Same thin-proxy pattern as
// /api/screening-runs/route.ts: this route only authenticates/authorizes
// the request and forwards it to the analyze-buy-setup Edge Function using
// the project's secret key, which never reaches the browser. A Viewer can
// never reach this route (requireRole throws before any fetch happens). The
// Edge Function itself is idempotent (see its own header comment) -- a
// repeated click while an enrichment is already processing or published
// returns that existing state rather than starting a duplicate.
export async function POST() {
  let user;
  try {
    user = await requireRole("researcher");
  } catch (err) {
    return NextResponse.json({ error: err instanceof Error ? err.message : "Forbidden" }, { status: 403 });
  }
  void user;

  const run = await getLatestPublishedRun();
  if (!run) {
    return NextResponse.json({ error: "No published screening run exists yet -- buy-setup analysis requires one." }, { status: 409 });
  }

  const functionUrl = process.env.ANALYZE_BUY_SETUP_FUNCTION_URL;
  const secretKey = process.env.SUPABASE_SECRET_KEY;
  if (!functionUrl || !secretKey) {
    return NextResponse.json({ error: "ANALYZE_BUY_SETUP_FUNCTION_URL / SUPABASE_SECRET_KEY not configured" }, { status: 500 });
  }

  const res = await fetch(functionUrl, {
    method: "POST",
    headers: { Authorization: `Bearer ${secretKey}`, "Content-Type": "application/json" },
    body: JSON.stringify({ run_id: run.id }),
  });

  if (!res.ok) {
    // The Edge Function's raw response body is an internal implementation
    // detail and must not reach the browser -- log it server-side with a
    // correlation id and return only that id, matching
    // /api/screening-runs/route.ts's own convention.
    const correlationId = crypto.randomUUID();
    const text = await res.text().catch(() => "");
    console.error(`[buy-setup-analysis] correlationId=${correlationId} upstream_status=${res.status} body=${text}`);
    return NextResponse.json({ error: "The buy-setup analysis could not be started. Please try again or contact support with this ID.", correlationId }, { status: 502 });
  }

  const body = await res.json().catch(() => ({}));
  return NextResponse.json(body);
}

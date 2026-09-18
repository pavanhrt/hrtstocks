import { NextResponse } from "next/server";
import { getCurrentUser } from "@/lib/auth";

// POST /api/fome-analysis -- starts a single-instrument FOME analysis.
// Deliberately thin, mirroring api/screening-runs/route.ts and
// api/buy-setup-analysis/route.ts's own contract: authenticate, forward to
// the Edge Function with the project's secret key (never exposed to the
// browser), never leak the upstream response body on failure. Any signed-in
// user may trigger this (not role-gated to Researcher+ like the
// full-universe screening run) -- a single-instrument analysis is the
// /fome page's core, low-cost, per-user research action.
export async function POST(req: Request) {
  const user = await getCurrentUser();
  if (!user) {
    return NextResponse.json({ error: "Sign in required." }, { status: 401 });
  }

  const body = await req.json().catch(() => ({}));
  const instrumentId = body.instrumentId;
  if (!instrumentId || typeof instrumentId !== "string") {
    return NextResponse.json({ error: "instrumentId is required." }, { status: 400 });
  }

  const functionUrl = process.env.FOME_ANALYSIS_FUNCTION_URL;
  const secretKey = process.env.SUPABASE_SECRET_KEY;
  if (!functionUrl || !secretKey) {
    return NextResponse.json(
      { error: "FOME_ANALYSIS_FUNCTION_URL / SUPABASE_SECRET_KEY not configured" },
      { status: 500 }
    );
  }

  const res = await fetch(functionUrl, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${secretKey}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({ instrument_id: instrumentId, triggered_by: user.id }),
  });

  if (!res.ok) {
    const correlationId = crypto.randomUUID();
    const text = await res.text().catch(() => "");
    console.error(`[fome-analysis] correlationId=${correlationId} upstream_status=${res.status} body=${text}`);
    return NextResponse.json(
      { error: "The FOME analysis could not be started. Please try again or contact support with this ID.", correlationId },
      { status: 502 }
    );
  }

  const responseBody = await res.json().catch(() => ({}));
  return NextResponse.json(responseBody);
}

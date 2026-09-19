import { NextResponse } from "next/server";

// Liveness for Cloud Run / uptime checks. Deliberately touches nothing else.
export const dynamic = "force-dynamic";

export function GET() {
  return NextResponse.json({ ok: true });
}

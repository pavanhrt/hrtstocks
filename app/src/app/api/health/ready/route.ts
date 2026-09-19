import { NextResponse } from "next/server";
import { getDb } from "@/lib/db/pool";

// Readiness: proves the app can reach and query its database (Cloud SQL IAM connectivity in QA) and reports
// how many migrations are applied. Public, no data: it returns counts only. Liveness is /api/health.
export const dynamic = "force-dynamic";

export async function GET() {
  try {
    const row = await getDb().one<{ n: number }>("select count(*)::int as n from schema_migrations");
    return NextResponse.json({ ok: true, migrationsApplied: row?.n ?? 0 });
  } catch {
    return NextResponse.json({ ok: false }, { status: 503 });
  }
}

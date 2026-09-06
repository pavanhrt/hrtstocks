import { NextResponse } from "next/server";
import { getCurrentUser } from "@/lib/auth";
import { getStockLedger } from "@/lib/data/runs";

function csvEscape(value: unknown): string {
  const s = value === null || value === undefined ? "" : String(value);
  return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

// GET /api/export/stocks?runId=... -- exportable complete ledger (per spec:
// "A ranked shortlist never replaces the complete all-stock ledger", so this
// exports every row RLS returns for the run, not just Tier A/B.
export async function GET(request: Request) {
  const user = await getCurrentUser();
  if (!user) return NextResponse.json({ error: "Sign in required" }, { status: 401 });

  const runId = new URL(request.url).searchParams.get("runId");
  if (!runId) return NextResponse.json({ error: "runId is required" }, { status: 400 });

  const rows = await getStockLedger(runId);

  const header = [
    "instrument_id",
    "symbol",
    "name",
    "terminal_state",
    "tier",
    "direction",
    "score",
    "data_quality",
    "failed_gates",
  ];
  const lines = [header.join(",")];
  for (const r of rows as any[]) {
    lines.push(
      [
        r.instrument_id,
        r.instruments?.symbol,
        r.instruments?.name,
        r.terminal_state,
        r.tier,
        r.direction,
        r.score,
        r.data_quality,
        (r.failed_gates ?? []).join("; "),
      ]
        .map(csvEscape)
        .join(",")
    );
  }

  return new NextResponse(lines.join("\n"), {
    headers: {
      "Content-Type": "text/csv; charset=utf-8",
      "Content-Disposition": `attachment; filename="stock-ledger-${runId}.csv"`,
    },
  });
}

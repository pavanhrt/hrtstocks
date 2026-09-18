import { NextResponse } from "next/server";
import { getCurrentUser } from "@/lib/auth";
import { getInstrumentFomeSummary } from "@/lib/data/fome";

// GET /api/instruments/{instrumentId}/summary -- the selection-panel details
// shown before the user clicks "Analyze latest data".
export async function GET(_req: Request, { params }: { params: Promise<{ instrumentId: string }> }) {
  const user = await getCurrentUser();
  if (!user) {
    return NextResponse.json({ error: "Sign in required." }, { status: 401 });
  }

  const { instrumentId } = await params;
  const summary = await getInstrumentFomeSummary(instrumentId);
  if (!summary) {
    return NextResponse.json({ error: "Unknown instrument." }, { status: 404 });
  }
  return NextResponse.json({ summary });
}

import { NextResponse } from "next/server";
import { getCurrentUser } from "@/lib/auth";
import { searchInstruments } from "@/lib/data/fome";

// GET /api/instruments/search?q=... -- backs the /fome page's autocomplete.
// A plain parameterized ilike query, never a provider (Fyers) call.
export async function GET(req: Request) {
  const user = await getCurrentUser();
  if (!user) {
    return NextResponse.json({ error: "Sign in required." }, { status: 401 });
  }

  const { searchParams } = new URL(req.url);
  const q = (searchParams.get("q") ?? "").slice(0, 64);
  if (q.trim().length === 0) {
    return NextResponse.json({ results: [] });
  }

  const results = await searchInstruments(q);
  return NextResponse.json({ results });
}

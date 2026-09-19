import { NextResponse } from "next/server";
import { z } from "zod";
import { getCurrentUser } from "@/lib/auth";
import { getDb } from "@/lib/db/pool";
import { createFomeRun, failFomeRun } from "@/lib/data/fome-runs";
import { startJob } from "@/lib/jobs";
import { csrfOk } from "@/lib/csrf";

const Body = z.object({ instrumentId: z.string().min(1).max(64) });

// POST /api/fome-analysis -- starts a single-instrument FOME analysis.
// Any signed-in user may trigger this (not role-gated like the full-universe
// screening run): it is the /fome page core, low-cost, per-user research
// action. The web app creates the run row (so the page can poll it at once) and
// launches a Cloud Run Job that does the work; repeated clicks for the same
// instrument within a few minutes reuse the in-flight run.
export async function POST(req: Request) {
  if (!csrfOk(req)) return NextResponse.json({ error: "Forbidden." }, { status: 403 });
  const user = await getCurrentUser();
  if (!user) return NextResponse.json({ error: "Sign in required." }, { status: 401 });

  const parsed = Body.safeParse(await req.json().catch(() => null));
  if (!parsed.success) return NextResponse.json({ error: "instrumentId is required." }, { status: 400 });

  const db = getDb();
  const created = await createFomeRun(db, { instrumentId: parsed.data.instrumentId, triggeredBy: user.id });
  if (!created) return NextResponse.json({ error: "Unknown instrument." }, { status: 404 });
  if (created.reused) return NextResponse.json({ runId: created.runId, status: "running" });

  try {
    await startJob("fome", { FOME_RUN_ID: created.runId });
  } catch (err) {
    const correlationId = crypto.randomUUID();
    console.error(`[fome-analysis] correlationId=${correlationId} job start failed:`, err);
    await failFomeRun(db, created.runId, "The analysis job could not be started.");
    return NextResponse.json(
      { error: "The FOME analysis could not be started. Please try again or contact support with this ID.", correlationId },
      { status: 502 },
    );
  }
  return NextResponse.json({ runId: created.runId, status: "running" });
}

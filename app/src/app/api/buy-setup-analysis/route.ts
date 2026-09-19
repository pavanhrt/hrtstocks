import { NextResponse } from "next/server";
import { authorizeApi } from "@/lib/auth";
import { getLatestPublishedRun } from "@/lib/data/runs";
import { startJob } from "@/lib/jobs";
import { csrfOk } from "@/lib/csrf";

// POST /api/buy-setup-analysis -- manual "Run buy-setup analysis" trigger
// (Researcher and above). Authenticates/authorizes, then starts the buy-setup
// Cloud Run Job for the latest published run. The job is idempotent (it
// re-uses an existing lease/manifest), so a repeated click while enrichment is
// already processing or published does not start duplicate work.
export async function POST(request: Request) {
  if (!csrfOk(request)) return NextResponse.json({ error: "Forbidden" }, { status: 403 });
  const auth = await authorizeApi("researcher");
  if (!auth.ok) return NextResponse.json({ error: auth.error }, { status: auth.status });

  const run = await getLatestPublishedRun();
  if (!run) {
    return NextResponse.json({ error: "No published screening run exists yet -- buy-setup analysis requires one." }, { status: 409 });
  }

  try {
    const started = await startJob("buy-setup", { RUN_ID: run.id });
    return NextResponse.json({ runId: run.id, status: "processing", execution: started.execution });
  } catch (err) {
    const correlationId = crypto.randomUUID();
    console.error(`[buy-setup-analysis] correlationId=${correlationId} job start failed:`, err);
    return NextResponse.json(
      { error: "The buy-setup analysis could not be started. Please try again or contact support with this ID.", correlationId },
      { status: 502 },
    );
  }
}

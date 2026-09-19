import { NextResponse } from "next/server";
import { authorizeApi } from "@/lib/auth";
import { startJob } from "@/lib/jobs";
import { csrfOk } from "@/lib/csrf";

// POST /api/screening-runs -- manual "Run now" (Researcher and above).
// Deliberately thin: authenticates/authorizes, then starts the screening Cloud
// Run Job. The job itself acquires the run lease (so a second click while a run
// is active is a safe no-op), creates the screening_runs row and does all the
// ingestion / rule-evaluation work -- see services/pipeline/src/jobs/screening.mjs.
export async function POST(request: Request) {
  if (!csrfOk(request)) return NextResponse.json({ error: "Forbidden" }, { status: 403 });
  const auth = await authorizeApi("researcher");
  if (!auth.ok) return NextResponse.json({ error: auth.error }, { status: auth.status });
  const user = auth.user;

  try {
    const started = await startJob("screening", { TRIGGER_TYPE: "manual", TRIGGERED_BY: user.id });
    return NextResponse.json({ status: "started", execution: started.execution });
  } catch (err) {
    // Internals (project ids, API error payloads) never reach the browser: log
    // with a correlation id and return only the id.
    const correlationId = crypto.randomUUID();
    console.error(`[screening-runs] correlationId=${correlationId} job start failed:`, err);
    return NextResponse.json(
      { error: "The screening run could not be started. Please try again or contact support with this ID.", correlationId },
      { status: 502 },
    );
  }
}

// Cloud Run Job entrypoint: EOD screening.
// Arguments (env; overridden per execution by the web app or Cloud Scheduler):
//   TRIGGER_TYPE     "scheduled" | "manual"   (default "scheduled")
//   TRIGGERED_BY     profiles.id of the person who clicked "Run" (manual runs)
//   RESUME_RUN_ID    resume an interrupted run instead of starting a new one
import { runScreeningJob } from "../run-screening/index.js";
import { openChartStore } from "../storage/charts.js";
import { requireUuidEnv, runJob } from "./runner.js";

await runJob("screening", async ({ db, env }) => {
  const triggerType = env.TRIGGER_TYPE === "manual" ? "manual" : "scheduled";
  const triggeredBy = env.TRIGGERED_BY ? requireUuidEnv("TRIGGERED_BY", env) : null;
  const resumeRunId = env.RESUME_RUN_ID ? requireUuidEnv("RESUME_RUN_ID", env) : null;
  const chartStore = await openChartStore(db, env);
  return runScreeningJob({ db, chartStore, triggerType, triggeredBy, resumeRunId });
});

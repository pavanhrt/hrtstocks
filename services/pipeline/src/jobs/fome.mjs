// Cloud Run Job entrypoint: single-instrument FOME analysis.
// Argument (env override set by the web app): FOME_RUN_ID -- an existing
// fome_analysis_runs row in status "queued".
import { runFomeJob } from "../fome-analysis/index.js";
import { openChartStore } from "../storage/charts.js";
import { requireUuidEnv, runJob } from "./runner.js";

await runJob("fome", async ({ db, env }) => {
  const runId = requireUuidEnv("FOME_RUN_ID", env);
  const chartStore = await openChartStore(db, env);
  return runFomeJob({ db, chartStore, runId });
});

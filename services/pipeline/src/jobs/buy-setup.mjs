// Cloud Run Job entrypoint: buy-setup enrichment for a published screening run.
// Argument (env override set by the web app): RUN_ID -- a screening_runs id whose
// publication_state is already 'published'.
import { runBuySetupJob } from "../analyze-buy-setup/index.js";
import { openChartStore } from "../storage/charts.js";
import { requireUuidEnv, runJob } from "./runner.js";

await runJob("buy-setup", async ({ db, env }) => {
  const runId = requireUuidEnv("RUN_ID", env);
  const chartStore = await openChartStore(db, env);
  return runBuySetupJob({ db, chartStore, runId });
});

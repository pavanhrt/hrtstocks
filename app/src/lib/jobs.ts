import { spawn } from "node:child_process";
import path from "node:path";
import { serverConfig } from "./config.ts";

/**
 * Starts pipeline work. Long-running work never runs inside a web request:
 * it runs as a Cloud Run Job execution (scale-to-zero, billed only while
 * running, up to hours of runtime), started here with per-execution arguments.
 * Cloud Scheduler starts the scheduled EOD run the same way.
 *
 * Arguments are passed as environment overrides; the job entrypoints validate
 * them (services/pipeline/src/jobs/*.mjs).
 */
export type JobName = "screening" | "buy-setup" | "fome";

export type JobArgs = Record<string, string>;

export type StartedJob = { execution: string | null };

/** The exact env override names each job accepts -- anything else is rejected before launch. */
const ALLOWED_ARGS: Record<JobName, readonly string[]> = {
  screening: ["TRIGGER_TYPE", "TRIGGERED_BY", "RESUME_RUN_ID"],
  "buy-setup": ["RUN_ID"],
  fome: ["FOME_RUN_ID"],
};

function assertArgs(job: JobName, args: JobArgs) {
  for (const [key, value] of Object.entries(args)) {
    if (!ALLOWED_ARGS[job].includes(key)) throw new Error(`Unsupported argument ${key} for job ${job}`);
    if (typeof value !== "string" || value.length > 128 || /[\r\n\0]/.test(value)) throw new Error(`Invalid value for ${key}`);
  }
}

function jobResourceName(job: JobName): string {
  const cfg = serverConfig();
  const name = { screening: cfg.SCREENING_JOB_NAME, "buy-setup": cfg.BUY_SETUP_JOB_NAME, fome: cfg.FOME_JOB_NAME }[job];
  if (!cfg.GCP_PROJECT || !cfg.GCP_REGION || !name) {
    throw new Error(`Cloud Run Job for "${job}" is not configured (GCP_PROJECT, GCP_REGION and the job name variable).`);
  }
  return `projects/${cfg.GCP_PROJECT}/locations/${cfg.GCP_REGION}/jobs/${name}`;
}

async function startCloudRunJob(job: JobName, args: JobArgs): Promise<StartedJob> {
  const { JobsClient } = await import("@google-cloud/run");
  const client = new JobsClient(); // Application Default Credentials: the runtime service account
  const [operation] = await client.runJob({
    name: jobResourceName(job),
    overrides: {
      containerOverrides: [{ env: Object.entries(args).map(([name, value]) => ({ name, value })) }],
    },
  });
  return { execution: operation.name ?? null };
}

/**
 * Local development only (JOB_RUNNER=local): run the job entrypoint as a
 * detached child process instead of a Cloud Run Job. Never used in Cloud Run.
 */
function startLocalJob(job: JobName, args: JobArgs): StartedJob {
  const script = path.join(process.cwd(), "..", "services", "pipeline", "src", "jobs", `${job}.mjs`);
  const child = spawn(process.execPath, [script], {
    env: { ...process.env, ...args },
    stdio: "ignore",
    detached: true,
  });
  child.unref();
  return { execution: `local:${child.pid}` };
}

export async function startJob(job: JobName, args: JobArgs = {}): Promise<StartedJob> {
  assertArgs(job, args);
  return serverConfig().JOB_RUNNER === "local" ? startLocalJob(job, args) : startCloudRunJob(job, args);
}
